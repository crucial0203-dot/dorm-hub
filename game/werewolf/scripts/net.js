(function initWerewolfNet(global){
    'use strict';

    var MQTTClient = (global.WW_MQTT_RELAY && global.WW_MQTT_RELAY.MQTTClient) || null;
    var CFG = global.WW_CONFIG;

    function mkRoomCode(){
        // 4 位数字，便于口播
        return String(Math.floor(1000 + Math.random() * 9000));
    }

    function nowMs(){ return Date.now(); }

    /**
     * 房主权威 MQTT 网络层。
     * topics: ww/<room>/state|action|chat|join|hello|dm/<pid>
     */
    class WerewolfNet {
        constructor(opts){
            opts = opts || {};
            this.roomCode = '';
            this.isHost = false;
            this.myPid = '';
            this.hostPid = '';
            this.handlers = {};
            this._relay = null;
            this._ready = false;
            this._destroyed = false;
            this._pending = [];
            this._pendingCap = 128;
            this._openFired = false;
            this._hbTimer = null;
            this._lastPeerAt = 0;
            this._onHostLeave = opts.onHostLeave || null;
            this._onPeerJoin = opts.onPeerJoin || null;
            this._onAction = opts.onAction || null;
            this._onChat = opts.onChat || null;
            this._onState = opts.onState || null;
            this._onPrivate = opts.onPrivate || null;
            this._onHello = opts.onHello || null;
            this._onError = opts.onError || null;
            this._peers = {}; // pid -> lastHB (host only)
        }

        on(type, cb){
            (this.handlers[type] = this.handlers[type] || []).push(cb);
            return this;
        }

        _fire(type){
            var args = [].slice.call(arguments, 1);
            (this.handlers[type] || []).slice().forEach(function(cb){
                try { cb.apply(null, args); } catch (e) { console.error('[ww-net]', type, e); }
            });
        }

        _broker(){
            var sel = 0;
            try { sel = CFG._readBrokerSelection(); } catch (e) { sel = 0; }
            var cands = CFG.NET_CONFIG.brokerCandidates || [];
            if (cands[sel]) return cands[sel];
            return cands[0];
        }

        _topicBase(){ return 'ww/' + this.roomCode; }

        relayReady(){
            return !!(this._relay && this._relay.opened && this._relay.ws && this._relay.ws.readyState === WebSocket.OPEN);
        }

        _publish(topic, msg){
            var payload = msg || {};
            if (this.relayReady()){
                this._relay.publish(topic, payload);
                return;
            }
            if (this._pending.length >= this._pendingCap){
                console.warn('[ww-net] pending full, drop', topic);
                return;
            }
            this._pending.push([topic, payload]);
        }

        _flushPending(){
            if (!this._pending.length) return;
            var arr = this._pending;
            this._pending = [];
            for (var i = 0; i < arr.length; i++){
                if (this.relayReady()) this._relay.publish(arr[i][0], arr[i][1]);
                else { this._pending = arr.slice(i); break; }
            }
        }

        _connectRelay(){
            var self = this;
            var b = this._broker();
            var base = this._topicBase();
            if (!MQTTClient) throw new Error('mqtt-relay 未加载');
            if (!CFG) throw new Error('config 未加载');

            this._relay = new MQTTClient({
                clientId: 'ww-' + Math.random().toString(36).slice(2, 10),
                url: b.url,
                subprotocol: b.subprotocol,
                onMessage: function(m){ self._route(m); },
                onClose: function(){ self._ready = false; },
                onError: function(e){
                    self._ready = false;
                    if (self._onError) self._onError(e);
                }
            });

            // 先登记订阅再 connect；仅 CONNACK 成功才 onOpen
            // 收窄订阅：不订房间 #，避免收到他人 dm/狼聊
            if (this.isHost){
                this._relay.subscribe(base + '/action');
                this._relay.subscribe(base + '/chat');
                this._relay.subscribe(base + '/join');
                this._relay.subscribe(base + '/hello');
            } else {
                this._relay.subscribe(base + '/state');
                this._relay.subscribe(base + '/hello');
                this._relay.subscribe(base + '/join');
                if (this.myPid) this._relay.subscribe(base + '/dm/' + this.myPid);
            }
            this._relay.onOpen = function(){
                self._ready = true;
                self._flushPending();
                self._fire('open');
            };
            this._relay.connect();
        }

        async createRoom(){
            this.isHost = true;
            this.roomCode = mkRoomCode();
            this.myPid = 'h-' + this.roomCode;
            this.hostPid = this.myPid;
            var self = this;
            return new Promise(function(res, rej){
                var settled = false;
                try {
                    self._connectRelay();
                } catch (e) {
                    rej(e);
                    return;
                }
                var to = setTimeout(function(){
                    if (settled) return;
                    settled = true;
                    rej(new Error('连接超时'));
                }, (CFG && CFG.NET_CONFIG.connectTimeoutMs) || 12000);

                self.on('open', function(){
                    if (settled) return;
                    settled = true;
                    clearTimeout(to);
                    self._startHB();
                    self._fireLocalOpen();
                    res(self.roomCode);
                });
                // 错误路径：mqtt-relay CONNACK 失败不会 fire open，靠超时 reject
            });
        }

        async joinRoom(code){
            this.isHost = false;
            this.roomCode = String(code || '').toUpperCase();
            if (!/^\d{4}$/.test(this.roomCode) && this.roomCode.length < 3){
                throw new Error('房间号无效');
            }
            this.hostPid = 'h-' + this.roomCode;
            // 刷新重进：同一房间复用 pid，房主按 seat 绑回身份
            var pidKey = 'ww_pid_' + this.roomCode;
            var savedPid = null;
            try { savedPid = localStorage.getItem(pidKey); } catch (e) { savedPid = null; }
            if (savedPid && String(savedPid).indexOf('c-' + this.roomCode + '-') === 0){
                this.myPid = String(savedPid);
            } else {
                this.myPid = 'c-' + this.roomCode + '-' + Math.random().toString(36).slice(2, 8);
                try { localStorage.setItem(pidKey, this.myPid); } catch (e) {}
            }
            var self = this;
            return new Promise(function(res, rej){
                var settled = false;
                try {
                    self._connectRelay();
                } catch (e) {
                    rej(e);
                    return;
                }
                var to = setTimeout(function(){
                    if (settled) return;
                    settled = true;
                    rej(new Error('连接超时'));
                }, (CFG && CFG.NET_CONFIG.connectTimeoutMs) || 12000);

                self.on('open', function(){
                    if (settled) return;
                    settled = true;
                    clearTimeout(to);
                    self._startHB();
                    self._fireLocalOpen();
                    res();
                });
            });
        }

        _fireLocalOpen(){
            if (this._openFired) return;
            this._openFired = true;
            this._fire('connected');
        }

        _startHB(){
            var self = this;
            if (this._hbTimer) clearInterval(this._hbTimer);
            this._lastPeerAt = nowMs();
            this._hbTimer = setInterval(function(){
                if (self._destroyed) return;
                if (self.isHost){
                    self._publish(self._topicBase() + '/hello', { t: 'hb', from: self.myPid, room: self.roomCode });
                    var now = nowMs();
                    Object.keys(self._peers).forEach(function(pid){
                        if (now - self._peers[pid] > ((CFG && CFG.NET_CONFIG.heartbeatTimeoutMs) || 30000)){
                            delete self._peers[pid];
                            self._fire('peerLeave', pid);
                        }
                    });
                } else {
                    self._publish(self._topicBase() + '/join', { t: 'hb', from: self.myPid, name: self.myName || '', room: self.roomCode });
                    if (self._lastPeerAt && nowMs() - self._lastPeerAt > ((CFG && CFG.NET_CONFIG.heartbeatTimeoutMs) * 2 || 60000)){
                        self._fire('hostLost');
                    }
                }
            }, (CFG && CFG.NET_CONFIG.heartbeatIntervalMs) || 10000);
        }

        /** host broadcasts public state + per-player private */
        broadcastState(publicState, privateMap, chat, systemLog){
            var base = this._topicBase();
            var payload = {
                t: 'state',
                from: this.myPid,
                room: this.roomCode,
                public: publicState,
                chat: chat || [],
                systemLog: systemLog || []
            };
            this._publish(base + '/state', payload);
            if (privateMap){
                Object.keys(privateMap).forEach(function(pid){
                    this._publish(base + '/dm/' + pid, {
                        t: 'private',
                        from: this.myPid,
                        room: this.roomCode,
                        private: privateMap[pid]
                    });
                }, this);
            }
        }

        sendAction(action){
            var msg = { t: 'action', from: this.myPid, room: this.roomCode, action: action };
            this._publish(this._topicBase() + '/action', msg);
            if (this.isHost && this._onAction) this._onAction(msg);
        }

        sendChat(text, channel){
            var body = String(text || '').slice(0, 500);
            var ch = channel || 'public';
            // 狼聊只走 action → 仅房主订阅；公屏 chat 房间内共享
            if (ch === 'wolf'){
                var act = {
                    t: 'action',
                    from: this.myPid,
                    room: this.roomCode,
                    action: { type: 'chat', channel: 'wolf', text: body }
                };
                this._publish(this._topicBase() + '/action', act);
                if (this.isHost && this._onAction) this._onAction(act);
                return;
            }
            var msg = {
                t: 'chat',
                from: this.myPid,
                room: this.roomCode,
                text: body,
                channel: ch
            };
            this._publish(this._topicBase() + '/chat', msg);
            if (this.isHost && this._onChat) this._onChat(msg);
        }

        sendJoin(name){
            this.myName = name;
            var msg = { t: 'join', from: this.myPid, room: this.roomCode, name: name };
            this._publish(this._topicBase() + '/join', msg);
            if (this.isHost && this._onPeerJoin) this._onPeerJoin(msg);
            // 请房主立刻回一份 state
            this._publish(this._topicBase() + '/hello', { t: 'hello', from: this.myPid, room: this.roomCode, wantState: true });
        }

        requestState(){
            this._publish(this._topicBase() + '/hello', { t: 'hello', from: this.myPid, room: this.roomCode, wantState: true });
        }

        _route(m){
            if (!m || !m.topic || !m.payload || typeof m.payload !== 'object') return;
            var parts = String(m.topic).split('/');
            if (parts[0] !== 'ww' || parts[1] !== this.roomCode) return;
            var kind = parts[2];
            var p = m.payload;
            var from = p.from;
            if (from && from === this.myPid) return;

            if (kind === 'hello'){
                if (p.t === 'hb'){
                    if (this.isHost && from){
                        this._peers[from] = nowMs();
                        this._lastPeerAt = nowMs();
                    } else if (!this.isHost){
                        this._lastPeerAt = nowMs();
                    }
                    return;
                }
                if (this.isHost && p.wantState && this._onHello){
                    this._lastPeerAt = nowMs();
                    this._onHello(p);
                }
                return;
            }

            if (kind === 'join'){
                if (p.t === 'hb'){
                    if (this.isHost && from) this._peers[from] = nowMs();
                    if (!this.isHost) this._lastPeerAt = nowMs();
                    return;
                }
                if (this.isHost && this._onPeerJoin) this._onPeerJoin(p);
                return;
            }

            if (kind === 'action'){
                if (this.isHost && this._onAction) this._onAction(p);
                return;
            }

            if (kind === 'chat'){
                if (this._onChat) this._onChat(p);
                return;
            }

            if (kind === 'state'){
                if (!this.isHost && from === this.hostPid && this._onState){
                    this._lastPeerAt = nowMs();
                    this._onState(p);
                }
                return;
            }

            if (kind === 'dm'){
                var pid = parts[3];
                if (pid === this.myPid && this._onPrivate) this._onPrivate(p);
                return;
            }
        }

        destroy(){
            this._destroyed = true;
            if (this._hbTimer) clearInterval(this._hbTimer);
            this._hbTimer = null;
            if (this._relay) this._relay.destroy();
            this._relay = null;
            this._ready = false;
        }
    }

    global.WW_NET = {
        WerewolfNet: WerewolfNet,
        mkRoomCode: mkRoomCode
    };
})(typeof window !== 'undefined' ? window : globalThis);
