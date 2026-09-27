(function initRuntimeConfig(global){
    // BASE_URL 动态推导:始终指向"本页面所在域名+目录",这样无论在哪个站点部署,
    // 分享链接/二维码都会指向当前部署而非写死的旧域名。
    var _loc=null;
    try{ _loc=(typeof location!=='undefined')?location:null; }catch(e){ _loc=null; }
    var BASE_URL = '';
    if(_loc && typeof _loc.origin==='string' && /^https?:\/\//i.test(_loc.origin)){
        var base=_loc.origin + (_loc.pathname||'/');
        // 若以 index.html 等文件作入口, 剥离文件名保留目录, 以便 ?room= 正常拼接
        base=base.replace(/\/[^/]*\.html?$/i,'/');
        // 保证以单个斜杠结尾 (目录型 url 应带尾斜杠, 便于相对资源解析)
        base=base.replace(/\/+$/,'')+'/';
        BASE_URL=base;
    } else {
        // 非浏览器环境 (测试/SSR) 回退到旧默认, 保证不报错
        BASE_URL='https://lu123bing.github.io/liars-gambit/';
    }
    const SUITS = ['♠','♥','♦','♣'];
    const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
    const RED_SUITS = new Set(['♥','♦']);
    const REMOTE_ONLINE_STORAGE_KEY = 'lg_enable_remote_online';
    const CUSTOM_TURN_STORAGE_KEY = 'lg_custom_turn_config';
    const DEFAULT_NET_CONFIG = {
        maxPlayers: 9,
        heartbeatIntervalMs: 10000,
        heartbeatTimeoutMs: 30000,
        connectTimeoutMs: 12000,
        challengeWindowMs: 100,
        peerDebug: 0,
        // 国内网络环境默认开启 TURN,公网/局域网也能跑(SymNAT 才需要)
        remoteOnlineEnabled: true,
        hostUseTurnIfConfigured: true,
        // STUN 列表:Cloudflare(全球 CDN,国内可达) 优先,然后 Google + 自带 fallback
        ice: {
            stun: [
                { urls: 'stun:stun.cloudflare.com:3478' },
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:global.stun.twilio.com:3478' }
            ]
        },
        // TURN:OpenRelay 公共服务(无需注册)+ metered.ca fallback
        // 公网 SymNAT / 校园网 / 公司网 等情况下必须靠 TURN 中继
        turn: {
            urls: [
                'turn:openrelay.metered.ca:80',
                'turn:openrelay.metered.ca:80?transport=tcp',
                'turn:openrelay.metered.ca:443',
                'turns:openrelay.metered.ca:443?transport=tcp',
                'turn:global.relay.metered.ca:80',
                'turns:global.relay.metered.ca:443?transport=tcp'
            ],
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        // PeerJS broker: 0.peerjs.com 默认,支持运行时 window.__LG_NET_CONFIG__.peers 数组覆盖
        peers: [
            { host: '0.peerjs.com', port: 443, path: '/', secure: true, name: 'peerjs-official' }
        ],
        // MQTT 中央中继 (真实时主通道): 默认国内节点, 浏览器直连, pub/sub 转发
        relay: {
            enabled: true,
            url: 'wss://broker-cn.emqx.io:8084/mqtt',
            subprotocol: 'mqtt'
        },
        // MQTT broker 备选清单 (index 0 = 默认, 国内可达优先)
        // 注意: 房主与加入方必须用同一 broker — 分享链接会带 ?broker=<index>
        brokerCandidates: [
            { url: 'wss://broker-cn.emqx.io:8084/mqtt', subprotocol: 'mqtt', label: 'EMQX 国内节点 (默认)' },
            { url: 'wss://broker.emqx.io:8084/mqtt', subprotocol: 'mqtt', label: 'EMQX 国际节点' },
            { url: 'wss://test.mosquitto.org:8081/mqtt', subprotocol: 'mqtt', label: 'Mosquitto 测试 broker' },
            { url: 'wss://broker.hivemq.com:8884/mqtt', subprotocol: 'mqtt', label: 'HiveMQ 公共 broker' }
        ]
    };

    const BROKER_SELECTION_STORAGE_KEY = 'lg_broker_selection';

    // 用户上次选择的 broker index (优先于默认)
    function _readBrokerSelection(){
        try{
            const stored=localStorage.getItem(BROKER_SELECTION_STORAGE_KEY);
            if(stored!==null){
                const idx=parseInt(stored,10);
                if(Number.isFinite(idx) && idx>=0 && idx<DEFAULT_NET_CONFIG.brokerCandidates.length){
                    return idx;
                }
            }
        }catch(e){}
        return 0;
    }
    function _setBrokerSelection(idx){
        try{
            localStorage.setItem(BROKER_SELECTION_STORAGE_KEY,String(idx));
        }catch(e){}
    }

    function _readRuntimeNetConfig(){
        let fromStorage={};
        try{
            const raw=localStorage.getItem('lg_net_config');
            if(raw) fromStorage=JSON.parse(raw)||{};
        }catch(e){}
        const fromWindow=(typeof window!=='undefined'&&window.__LG_NET_CONFIG__&&typeof window.__LG_NET_CONFIG__==='object')
            ? window.__LG_NET_CONFIG__ : {};
        const merged={...DEFAULT_NET_CONFIG,...fromStorage,...fromWindow};
        merged.ice={
            ...DEFAULT_NET_CONFIG.ice,
            ...(fromStorage.ice||{}),
            ...(fromWindow.ice||{})
        };
        merged.turn={
            ...DEFAULT_NET_CONFIG.turn,
            ...(fromStorage.turn||{}),
            ...(fromWindow.turn||{})
        };
        return merged;
    }

    const NET_CONFIG = _readRuntimeNetConfig();

    function _readRemoteOnlineEnabled(){
        // 优先级:window 全局注入 > localStorage 用户上次选择 > NET_CONFIG 默认值
        try{
            const stored=localStorage.getItem(REMOTE_ONLINE_STORAGE_KEY);
            if(stored!==null){
                const v=String(stored)==='true';
                NET_CONFIG.remoteOnlineEnabled=v;
                return v;
            }
        }catch(e){}
        // 首次加载,使用默认值 (默认 true,适配国内网络)
        return NET_CONFIG.remoteOnlineEnabled!==false;
    }

    function _setRemoteOnlineEnabled(enabled){
        NET_CONFIG.remoteOnlineEnabled=!!enabled;
        // 持久化用户选择 (下次刷新记住)
        try{ localStorage.setItem(REMOTE_ONLINE_STORAGE_KEY,String(!!enabled)); }catch(e){}
    }

    function _normalizeTurnUrls(raw){
        if(Array.isArray(raw)) return raw.map(v=>String(v||'').trim()).filter(Boolean);
        return String(raw||'').split(/[\n,]+/).map(v=>v.trim()).filter(Boolean);
    }

    function _readCustomTurnConfig(){
        try{
            const raw=localStorage.getItem(CUSTOM_TURN_STORAGE_KEY);
            if(!raw) return null;
            const cfg=JSON.parse(raw)||{};
            return {
                urls:_normalizeTurnUrls(cfg.urls),
                username:String(cfg.username||'').trim(),
                credential:String(cfg.credential||'').trim()
            };
        }catch(e){
            return null;
        }
    }

    function _setCustomTurnConfig(cfg){
        try{
            localStorage.setItem(CUSTOM_TURN_STORAGE_KEY,JSON.stringify({
                urls:_normalizeTurnUrls(cfg?.urls),
                username:String(cfg?.username||'').trim(),
                credential:String(cfg?.credential||'').trim()
            }));
        }catch(e){}
    }

    function _clearCustomTurnConfig(){
        try{ localStorage.removeItem(CUSTOM_TURN_STORAGE_KEY); }catch(e){}
    }

    function _getEffectiveTurnConfig(){
        const c=_readCustomTurnConfig();
        if(c&&c.urls?.length&&c.username&&c.credential) return c;
        return NET_CONFIG.turn||{};
    }

    function _isCustomTurnConfigActive(){
        const c=_readCustomTurnConfig();
        return !!(c&&c.urls?.length&&c.username&&c.credential);
    }

    function _getRoomMaxPlayers(){
        if(!NET_CONFIG.remoteOnlineEnabled) return 9;
        return _isCustomTurnConfigActive()?9:6;
    }

    NET_CONFIG.remoteOnlineEnabled=_readRemoteOnlineEnabled();

    const HEARTBEAT_INTERVAL = NET_CONFIG.heartbeatIntervalMs;
    const HEARTBEAT_TIMEOUT = NET_CONFIG.heartbeatTimeoutMs;
    const CHALLENGE_WINDOW_MS = NET_CONFIG.challengeWindowMs;
    const DECK_COLORS = [
        { primary:'#B8453A', symbol:'●' },
        { primary:'#4A7C96', symbol:'◆' },
        { primary:'#6B7F4E', symbol:'▲' },
    ];

    global.LG_RUNTIME_CONFIG = {
        BASE_URL,
        SUITS,
        RANKS,
        RED_SUITS,
        REMOTE_ONLINE_STORAGE_KEY,
        CUSTOM_TURN_STORAGE_KEY,
        DEFAULT_NET_CONFIG,
        NET_CONFIG,
        MQTT_RELAY_CONFIG: NET_CONFIG.relay || { enabled: false, url: '', subprotocol: '' },
        HEARTBEAT_INTERVAL,
        HEARTBEAT_TIMEOUT,
        CHALLENGE_WINDOW_MS,
        DECK_COLORS,
        _readRuntimeNetConfig,
        _readRemoteOnlineEnabled,
        _setRemoteOnlineEnabled,
        _normalizeTurnUrls,
        _readCustomTurnConfig,
        _setCustomTurnConfig,
        _clearCustomTurnConfig,
        _getEffectiveTurnConfig,
        _isCustomTurnConfigActive,
        _getRoomMaxPlayers,
        BROKER_SELECTION_STORAGE_KEY,
        _readBrokerSelection,
        _setBrokerSelection,
    };
})(window);
