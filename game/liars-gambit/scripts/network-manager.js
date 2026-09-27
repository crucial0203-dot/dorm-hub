(function initNetworkManager(global){
    const { MQTTClient } = global.LG_MQTT_RELAY;

    // =========================================================================
    // PeerMQTT —— 模拟 PeerJS Peer/DataConnection 公共 API 的 MQTT 背衬实现。
    // -------------------------------------------------------------------------
    // 目的: 让外层 (network-manager + app-controller 的 _becomeHost/_reconnectNewHost)
    //       的既有 PeerJS 调用方式 (new Peer / on('connection') / connect() /
    //       conn.on('data') / conn.send()) 一行不改, 内部全部走 MQTT 中央中继,
    //       从根本上绕开 NAT 打洞。
    // =========================================================================
    class MQTTConn {
        constructor(remoteId, sendFn){
            this.peer=remoteId;   // 对端逻辑 peer id
            this.open=true;
            this._sendFn=sendFn;
            this._l={};
        }
        on(t,cb){ (this._l[t]=this._l[t]||[]).push(cb); return this; }
        fire(t){
            (this._l[t]||[]).slice().forEach(cb=>{
                try{ cb.apply(null,[].slice.call(arguments,1)); }catch(e){ console.error('[conn]',t,e); }
            });
        }
        send(msg){ if(this.open&&this._sendFn) this._sendFn(msg); }
        close(){ this.open=false; this.fire('close'); }
    }

    class PeerMQTT {
        constructor(id, opts){
            this.id = (typeof id==='string'&&id)?id:null;   // host 传 pid; client 传 null
            this._listeners={};
            this._conns=new Map();       // host: fromId -> MQTTConn
            this._hostConn=null;         // client: 到 host 的 conn
            this._relay=null; this._ready=false; this._destroyed=false;
            this._openFired=false;

            // 从最近创建的 NetworkManager 取房间上下文
            this._net = global.LG_NETWORK_MANAGER && global.LG_NETWORK_MANAGER.__lastCreated;
            this._roomCode = this._net ? this._net.roomCode : '';
            this._isHost = !!this.id && (this._net ? this._net.isHost : true);
            // host 逻辑 id = 传入 pid; client 逻辑 id = 随机
            this._ownPeerId = this._isHost
                ? this.id
                : 'lg-'+(this._roomCode||'x')+'-c-'+Math.random().toString(36).slice(2,9);
            this._hostPid = this._net ? this._net.hostPeerId : '';
            if(this._isHost&&this._net){ this._net.hostPeerId = this._ownPeerId; }

            // 触发出站条件: room code 必须可用
            if(this._roomCode){
                this._start();
            } else {
                // 兜底: 稍后再试 (迁移里 net.roomCode 可能先在 Peer 之后设置? 不会)
                setTimeout(()=>{ if(!this._roomCode&&this._net){ this._roomCode=this._net.roomCode; this._start(); } },0);
            }
        }

        _start(){
            if(this._started) return; this._started=true;
            const self=this;
            // 优先读取运行时 relay 配置 (url/subprotocol), 否则用 MQTTClient 内置默认
            let relayUrl, relaySub, selIdx=0, cands=null;
            try{
                const RC=global.LG_RUNTIME_CONFIG;
                cands=RC && RC.NET_CONFIG && RC.NET_CONFIG.brokerCandidates;
                selIdx=(RC && typeof RC._readBrokerSelection==='function')?RC._readBrokerSelection():0;
                if(Array.isArray(cands)&&cands.length && cands[selIdx]){
                    relayUrl=cands[selIdx].url;
                    relaySub=cands[selIdx].subprotocol;
                } else if(RC && RC.NET_CONFIG && RC.NET_CONFIG.relay){
                    relayUrl=RC.NET_CONFIG.relay.url;
                    relaySub=RC.NET_CONFIG.relay.subprotocol;
                } else if(RC && RC.MQTT_RELAY_CONFIG){
                    relayUrl=RC.MQTT_RELAY_CONFIG.url;
                    relaySub=RC.MQTT_RELAY_CONFIG.subprotocol;
                }
            }catch(_e){ relayUrl=undefined; relaySub=undefined; }
            // 先登记订阅主题, 再 connect — CONNACK 成功后 _resubscribeAll 会补发
            this._roomTopic='lg/'+this._roomCode+'/#';
            this._relay=new MQTTClient({
                clientId:'lg-mqtt-'+Math.random().toString(36).slice(2,10),
                url: relayUrl || undefined,
                subprotocol: relaySub || undefined,
                onMessage:(m)=>this._route(m),
            });
            this._relay._brokerUrl=relayUrl||'(default)';
            this._relay._brokerLabel=(cands&&cands[selIdx]&&cands[selIdx].label)||'(default)';
            // 仅 CONNACK 成功才会走到这里 (mqtt-relay 保证)
            this._relay.onOpen=()=>{
                this._ready=true;
                this._flushPending();
                this._fireOpenOnce();
            };
            this._relay.subscribe(this._roomTopic); // 未 open 时只入 topics 列表
            this._relay.connect();
        }

        _fireOpenOnce(){
            if(this._openFired) return;
            this._openFired=true;
            this._fire('open', this._ownPeerId);
        }

        on(t,cb){ (this._listeners[t]=this._listeners[t]||[]).push(cb); return this; }
        _fire(t){
            (this._listeners[t]||[]).slice().forEach(cb=>{
                try{ cb.apply(null,[].slice.call(arguments,1)); }catch(e){ console.error('[peer]',t,e); }
            });
        }

        // 客户端: 建立到 host 的虚拟连接
        connect(pid, _opts){
            const self=this;
            const conn=new MQTTConn(pid, function send(msg){
                // 始终走 _publish: 未 ready 时入队, CONNACK 后 flush — 禁止静默丢弃
                self._publish('lg/'+self._roomCode+'/cmd/'+self._ownPeerId, msg);
            });
            this._hostConn=conn;
            // 虚拟连接立即 open; 真正可发依赖 peer open (= relay CONNACK) 之后的 _publish 队列
            setTimeout(()=>conn.fire('open'),0);
            return conn;
        }

        relayReady(){ return !!(this._relay&&this._relay.opened&&this._relay.ws&&this._relay.ws.readyState===WebSocket.OPEN); }
        publishState(msg){ this._publish('lg/'+this._roomCode+'/state', msg); }
        publishCmdTo(pid,msg){ this._publish('lg/'+this._roomCode+'/cmd/'+pid, msg); }
        publishMyCmd(msg){ this._publish('lg/'+this._roomCode+'/cmd/'+this._ownPeerId, msg); }
        _publish(topic,msg){
            const enriched=Object.assign({from:this._ownPeerId}, msg||{});
            if(this.relayReady()){ this._relay.publish(topic, enriched); return; }
            // relay 未 ready (CONNACK 还没到, 或 ws 关闭/失败) — 入队, onOpen/重连时 flush
            if(!this._pending){ this._pending=[]; this._pendingCap=64; }
            if(this._pending.length<this._pendingCap){ this._pending.push([topic,enriched]); }
            else { console.warn('[peer] pending queue full, drop msg', topic); }
        }
        _flushPending(){
            if(!this._pending||!this._pending.length)return;
            const arr=this._pending; this._pending=[];
            for(const [t,m] of arr){
                if(this.relayReady()) this._relay.publish(t,m);
                else { this._pending.push([t,m]); break; } // 仍不可达就回填并停
            }
        }

        _route(m){
            const topic=m.topic; const payload=m.payload;
            if(!payload||typeof payload!=='object')return;
            const parts=String(topic).split('/');
            if(parts.length<3||parts[0]!=='lg')return;
            const topicRoom=parts[1], typePart=parts[2];
            if(topicRoom!==this._roomCode)return;
            const from=payload.from;
            if(!from||from===this._ownPeerId)return; // 丢弃无来源/自己的回包

            if(this._isHost){
                // host: 任意客户端命令 → 路由到对应虚拟连接
                this._hostDeliver(from, payload);
            } else {
                // client: 只收 host 广播(state) + 发给我的 cmd/<myId>
                if(typePart==='state' && from===this._hostPid){
                    if(this._hostConn) this._hostConn.fire('data', payload);
                }
                else if(typePart==='cmd' && parts[3]===this._ownPeerId && from===this._hostPid){
                    if(this._hostConn) this._hostConn.fire('data', payload);
                }
            }
        }

        _hostDeliver(fromId, msg){
            let c=this._conns.get(fromId);
            if(!c){
                const self=this;
                c=new MQTTConn(fromId, function send(msg){ self.publishCmdTo(fromId, msg); });
                this._conns.set(fromId, c);
                this._fire('connection', c);   // → _setupConn(c) 注册 open/data
                c.fire('open');
            }
            c.fire('data', msg);
        }

        destroy(){
            this._destroyed=true;
            if(this._relay) this._relay.destroy();
            this._conns.clear(); this._hostConn=null;
        }
    }
    // 兼容 PeerJS 的 .reconnect()
    PeerMQTT.prototype.reconnect=function(){ /* MQTTClient 已内置断线自动重连, 无需额外处理 */ };

    // 关键: 让 app-controller 迁移代码里的裸 `Peer` 指到 PeerMQTT
    global.Peer = PeerMQTT;

    class NetworkManager {
        constructor(){
            this.peer=null; this.connections=new Map();
            this.isHost=false; this.hostPeerId=null; this.hostConn=null;
            this.myPeerId=null; this.roomCode=''; this.handlers={};
            this.heartbeatTimer=null; this.onPeerConnect=null; this.onPeerDisconnect=null;
            this.destroyed=false; this._lastHostHB=0;
            global.LG_NETWORK_MANAGER=global.LG_NETWORK_MANAGER||{};
            global.LG_NETWORK_MANAGER.__lastCreated=this;  // 供 PeerMQTT 取房间上下文
        }
        _pid(code){ return 'lg-'+code; }
        _hasTurnConfig(){ return false; } // MQTT 主通道无需 TURN
        _peerOptions(useTurn=false){ return { mqtt:true, debug:NET_CONFIG.peerDebug }; }

        async createRoom(){
            this.isHost=true; this.roomCode=mkRoomCode();
            const pid=this._pid(this.roomCode); this.hostPeerId=pid;
            const self=this;
            return new Promise((res,rej)=>{
                try{
                    this.peer=new Peer(pid,this._peerOptions(!!NET_CONFIG.hostUseTurnIfConfigured));
                    const to=setTimeout(()=>rej(new Error('连接超时')),NET_CONFIG.connectTimeoutMs||12000);
                    this.peer.on('open',id=>{
                        clearTimeout(to);
                        this.myPeerId=id; this.hostPeerId=id;
                        this.peer.on('connection',c=>this._setupConn(c));
                        this._startHB(); res(this.roomCode);
                    });
                    this.peer.on('error',e=>{ console.error('[peer]',e); rej(e instanceof Error?e:new Error('连接失败')); });
                }catch(e){ rej(e); }
            });
        }

        async joinRoom(code){
            this.isHost=false; this.roomCode=code.toUpperCase();
            const hpid=this._pid(this.roomCode); this.hostPeerId=hpid;
            const self=this;
            return new Promise((res,rej)=>{
                try{
                    this.peer=new Peer(undefined,this._peerOptions(false));
                    const to=setTimeout(()=>rej(new Error('连接超时')),NET_CONFIG.connectTimeoutMs||12000);
                    this.peer.on('open',id=>{
                        this.myPeerId=id;
                        const conn=this.peer.connect(hpid,{reliable:true});
                        const cto=setTimeout(()=>rej(new Error('连接超时')),8000);
                        conn.on('open',()=>{
                            clearTimeout(to); clearTimeout(cto);
                            this.hostConn=conn; this._setupHostConn(conn); this._startHB(); res();
                        });
                        conn.on('error',e=>{ clearTimeout(to); clearTimeout(cto); rej(e); });
                    });
                    this.peer.on('error',e=>{ clearTimeout(to); rej(e); });
                }catch(e){ rej(e); }
            });
        }

        // Setup for host receiving client messages
        _setupConn(conn){
            const pid=conn.peer;
            conn.on('open',()=>{
                this.connections.set(pid,{conn,lastHB:Date.now()});
                if(this.onPeerConnect) this.onPeerConnect(pid,conn);
            });
            conn.on('data',d=>{
                if(d&&d.type==='HEARTBEAT'){const e=this.connections.get(pid);if(e)e.lastHB=Date.now();return;}
                this._dispatch(d,pid);
            });
            conn.on('close',()=>{
                this.connections.delete(pid);
                if(this.onPeerConnect) {} // noop
                if(this.onPeerDisconnect) this.onPeerDisconnect(pid);
            });
            conn.on('error',()=>{});
        }

        // Setup for client receiving from host
        _setupHostConn(conn){
            conn.on('data',d=>{
                if(d&&d.type==='HEARTBEAT'){this._lastHostHB=Date.now();return;}
                this._dispatch(d,conn.peer===this.hostPeerId?this.hostPeerId:conn.peer);
            });
            conn.on('close',()=>{
                if(this.onPeerDisconnect) this.onPeerDisconnect(this.hostPeerId);
            });
            this._lastHostHB=Date.now();
        }

        send(pid,msg){
            if(this.isHost&&this.peer){ this.peer.publishCmdTo(pid,msg); }
            else if(this.hostConn&&this.hostConn.open){ this.hostConn.send(msg); }
        }
        sendToHost(msg){
            if(this.isHost){ this._dispatch(msg,this.myPeerId||this.hostPeerId); }
            else if(this.hostConn&&this.hostConn.open){ this.hostConn.send(msg); }
            else if(this.peer){ this.peer.publishMyCmd(msg); }
        }
        broadcast(msg){ if(this.peer&&this.isHost) this.peer.publishState(msg); }
        broadcastAndSelf(msg){ this.broadcast(msg); this._dispatch(msg,this.myPeerId||this.hostPeerId); }

        on(type,handler){ if(!this.handlers[type])this.handlers[type]=[];this.handlers[type].push(handler);}
        off(type){ delete this.handlers[type]; }
        _dispatch(d,from){ if(!d||!d.type)return;const hs=this.handlers[d.type];if(hs)hs.forEach(h=>h(d,from)); }

        // Client-only 重连当前房主
        async reconnectToHost(){
            if(this.isHost||!this.roomCode||!this.hostPeerId) throw new Error('当前不是客户端，无法重连');
            const hpid=this.hostPeerId;
            const self=this;
            return new Promise((res,rej)=>{
                try{ if(this.peer) this.peer.destroy(); }catch(_e){}
                this.peer=new Peer(undefined,this._peerOptions(false));
                const to=setTimeout(()=>rej(new Error('连接超时')),NET_CONFIG.connectTimeoutMs||12000);
                this.peer.on('open',id=>{
                    this.myPeerId=id;
                    const conn=this.peer.connect(hpid,{reliable:true});
                    const cto=setTimeout(()=>rej(new Error('连接超时')),8000);
                    conn.on('open',()=>{
                        clearTimeout(to); clearTimeout(cto);
                        this.hostConn=conn; this._setupHostConn(conn); this._startHB(); res();
                    });
                    conn.on('error',e=>{ clearTimeout(to); clearTimeout(cto); rej(e); });
                });
                this.peer.on('error',e=>{ clearTimeout(to); rej(e); });
            });
        }

        _startHB(){
            if(this.heartbeatTimer) clearInterval(this.heartbeatTimer);
            const hb=()=>({type:'HEARTBEAT',t:Date.now()});
            this.heartbeatTimer=setInterval(()=>{
                const m=hb();
                if(this.isHost){
                    this.broadcast(m);
                    const now=Date.now();
                    for(const[pid,en]of this.connections){
                        if(now-en.lastHB>HEARTBEAT_TIMEOUT){
                            en.conn.close(); this.connections.delete(pid);
                            if(this.onPeerDisconnect)this.onPeerDisconnect(pid);
                        }
                    }
                } else {
                    if(this.hostConn&&this.hostConn.open) this.hostConn.send(m);
                    if(this._lastHostHB && Date.now()-this._lastHostHB>HEARTBEAT_TIMEOUT){
                        if(this.onPeerDisconnect) this.onPeerDisconnect(this.hostPeerId);
                        this._lastHostHB = Date.now()+60000;
                    }
                }
            },HEARTBEAT_INTERVAL);
        }

        destroy(){
            this.destroyed=true; clearInterval(this.heartbeatTimer);
            if(this.peer)this.peer.destroy(); this.connections.clear();
            this.hostConn=null;
        }
    }

    const {
        NET_CONFIG,
        HEARTBEAT_TIMEOUT,
        HEARTBEAT_INTERVAL,
        _getEffectiveTurnConfig,
    } = global.LG_RUNTIME_CONFIG;
    const { mkRoomCode } = global.LG_RUNTIME_UTILS;

    global.LG_NETWORK_MANAGER=global.LG_NETWORK_MANAGER||{};
    global.LG_NETWORK_MANAGER.NetworkManager=NetworkManager;
})(window);