(function initWerewolfApp(global){
    'use strict';

    var CFG = global.WW_CONFIG;
    var NET = global.WW_NET;
    var ENG = global.WW_ENGINE;
    var WerewolfEngine = ENG.WerewolfEngine;
    var PHASE = ENG.PHASE;
    var ROLE_LABEL = ENG.ROLE_LABEL;
    var ROLES = ENG.ROLES;
    var BOARDS = ENG.BOARDS;

    function $(id){ return document.getElementById(id); }

    function toast(msg, ms){
        var el = $('toast');
        if (!el) return;
        el.textContent = msg;
        el.classList.add('show');
        clearTimeout(el._t);
        el._t = setTimeout(function(){ el.classList.remove('show'); }, ms || 2600);
    }

    function showScreen(name){
        ['home', 'lobby', 'game'].forEach(function(s){
            var el = $('screen-' + s);
            if (el) el.classList.toggle('active', s === name);
        });
    }

    function phaseLabel(phase){
        switch (phase){
            case PHASE.LOBBY: return '大厅';
            case PHASE.DEAL: return '发身份';
            case PHASE.NIGHT_GUARD: return '夜 · 守卫行动';
            case PHASE.NIGHT_WOLF: return '夜 · 狼人行动';
            case PHASE.NIGHT_SEER: return '夜 · 预言家查验';
            case PHASE.NIGHT_WITCH: return '夜 · 女巫用药';
            case PHASE.DAWN: return '天亮了';
            case PHASE.SHERIFF_NOM: return '警长竞选报名';
            case PHASE.SHERIFF_DISCUSS: return '警长竞选发言';
            case PHASE.SHERIFF_VOTE: return '警长投票';
            case PHASE.DISCUSS: return '白天讨论';
            case PHASE.VOTE: return '放逐投票';
            case PHASE.RESOLVE: return '结算';
            case PHASE.GAME_OVER: return '游戏结束';
            default: return phase;
        }
    }

    function isNight(phase){
        return phase === PHASE.NIGHT_GUARD || phase === PHASE.NIGHT_WOLF ||
            phase === PHASE.NIGHT_SEER || phase === PHASE.NIGHT_WITCH;
    }

    var App = {
        net: null,
        engine: null,
        isHost: false,
        myPid: '',
        myName: '',
        public: null,
        private: null,
        chat: [],
        systemLog: [],
        boardId: '9',
        _joined: false,
        _rate: [],

        init: function(){
            CFG._applyBrokerFromUrl();
            var saved = CFG._readName();
            if (saved) $('input-name').value = saved;
            $('btn-create').onclick = this.create.bind(this);
            $('btn-join').onclick = this.join.bind(this);
            $('input-room-code').addEventListener('keyup', function(e){
                if (e.key === 'Enter') App.join();
            });
            $('btn-share').onclick = this.share.bind(this);
            $('btn-start').onclick = this.start.bind(this);
            document.addEventListener('click', function(e){
                var t = e.target;
                if (t && t.id === 'btn-leave') App.leave();
            });
            $('btn-send-chat').onclick = this.sendChat.bind(this);
            $('input-chat').addEventListener('keydown', function(e){
                if (e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); App.sendChat(); }
            });
            $('board-9').onclick = function(){ App.setBoard('9'); };
            $('board-12').onclick = function(){ App.setBoard('12'); };

            var room = CFG._readRoomFromUrl();
            if (room){
                $('input-room-code').value = room;
                history.replaceState(null, '', window.location.pathname);
                setTimeout(function(){ App.join(true); }, 500);
            }

            setInterval(this.tickHost.bind(this), 250);
            setInterval(this.renderClock.bind(this), 250);
        },

        _name: function(){
            var n = ($('input-name').value || '').trim().slice(0, 12);
            if (!n){ toast('请先填写昵称'); return null; }
            CFG._saveName(n);
            return n;
        },

        _resetView: function(){
            this.public = null;
            this.private = null;
            this.chat = [];
            this.systemLog = [];
            this._joined = false;
        },

        create: async function(){
            var name = this._name();
            if (!name) return;
            this.myName = name;
            this._resetView();
            try {
                $('btn-create').disabled = true;
                $('btn-create').textContent = '创建中…';
                this.net = new NET.WerewolfNet({});
                this._wireNet();
                var code = await this.net.createRoom();
                this.isHost = true;
                this.myPid = this.net.myPid;
                this.engine = new WerewolfEngine({ boardId: this.boardId });
                this.engine.reset([{ pid: this.myPid, name: name }]);
                this.engine.boardId = this.boardId;
                this._joined = true;
                this._pushSystem('房主 ' + name + ' 创建了房间 ' + code);
                this.broadcast();
                showScreen('lobby');
                $('lobby-room-code').textContent = code;
                toast('房间已创建：' + code);
            } catch (e){
                toast('创建失败：' + (e && e.message || e));
                if (this.net){ this.net.destroy(); this.net = null; }
            } finally {
                $('btn-create').disabled = false;
                $('btn-create').textContent = '创建房间';
            }
        },

        join: async function(auto){
            var name = this._name();
            if (!name) return;
            var code = ($('input-room-code').value || '').trim().toUpperCase();
            if (code.length < 3){ toast('请输入房间号'); return; }
            this.myName = name;
            this._resetView();
            try {
                $('btn-join').disabled = true;
                $('btn-join').textContent = '加入中…';
                this.net = new NET.WerewolfNet({});
                this._wireNet();
                await this.net.joinRoom(code);
                this.isHost = false;
                this.myPid = this.net.myPid;
                this.net.sendJoin(name);
                this.net.requestState();
                var self = this;
                setTimeout(function(){
                    if (!self._joined) toast('房间不存在或房主未响应');
                }, 4000);
                toast(auto ? ('自动加入 ' + code + '…') : ('已连接，等待房主确认 ' + code));
            } catch (e){
                toast('加入失败：' + (e && e.message || e));
                if (this.net){ this.net.destroy(); this.net = null; }
            } finally {
                $('btn-join').disabled = false;
                $('btn-join').textContent = '加入';
            }
        },

        _wireNet: function(){
            var self = this;
            this.net.onError = function(e){
                toast('无法连接中继/broker：' + (e && e.message || '网络错误'));
            };
            this.net._onPeerJoin = function(msg){ self._hostOnJoin(msg); };
            this.net._onAction = function(msg){ self._hostOnAction(msg); };
            this.net._onChat = function(msg){ self._hostOnChat(msg); };
            this.net._onState = function(msg){ self._clientOnState(msg); };
            this.net._onPrivate = function(msg){
                if (msg && msg.private){
                    self.private = msg.private;
                    if (msg.private.chat) self.chat = msg.private.chat;
                }
                self.renderAll();
            };
            this.net._onHello = function(msg){ self._hostOnHello(msg); };
            this.net.on('hostLost', function(){
                toast('房主已断线，房间解散');
                if (self.public && self.public.phase !== PHASE.LOBBY && self.public.phase !== PHASE.GAME_OVER){
                    self.public = Object.assign({}, self.public, {
                        phase: PHASE.GAME_OVER,
                        winner: self.public.winner || null,
                        phaseDeadline: 0
                    });
                    if (self.engine) self.engine.logSystem('房主断线，本局解散。');
                    self.systemLog = self.engine ? self.engine.systemLog : self.systemLog;
                    self.renderAll();
                } else {
                    showScreen('home');
                }
            });
            this.net.on('peerLeave', function(){ /* seat connected flags optional */ });
        },

        _ensurePlayer: function(pid, name){
            if (!this.engine) return;
            var p = this.engine.player(pid);
            if (!p){
                if (this.engine.locked) return;
                if (this.engine.players.length >= (BOARDS[this.engine.boardId] || BOARDS['9']).size) return;
                this.engine.players.push({
                    pid: String(pid),
                    name: String(name || ('玩家' + (this.engine.players.length + 1))),
                    seat: this.engine.players.length,
                    alive: true,
                    role: null,
                    connected: true
                });
                this._pushSystem((name || pid) + ' 加入了房间');
            } else {
                p.connected = true;
                if (name) p.name = name;
            }
        },

        _hostOnJoin: function(msg){
            if (!this.isHost || !this.engine) return;
            if (this.engine.locked) return;
            this._ensurePlayer(msg.from, msg.name);
            this.broadcast();
        },

        _hostOnHello: function(){
            if (!this.isHost || !this.engine) return;
            this.broadcast();
        },

        _hostOnAction: function(msg){
            if (!this.isHost || !this.engine) return;
            var pid = msg.from;
            if (!pid) return;
            var action = msg.action || {};
            if (action.type === 'chat'){
                this._hostOnChat({ from: pid, text: action.text, channel: action.channel });
                return;
            }
            if (action.type === 'joinSeat'){
                this._ensurePlayer(pid, action.name);
                this.broadcast();
                return;
            }
            var r = this.engine.submitAction(pid, action);
            if (!r || !r.ok) return;
            this.broadcast();
        },

        _hostOnChat: function(msg){
            if (!this.isHost || !this.engine) return;
            var now = Date.now();
            this._rate = this._rate.filter(function(t){ return now - t < 10000; });
            if (this._rate.length >= 5) return;
            this._rate.push(now);
            var ch = 'public';
            if (msg.channel === 'wolf'){
                var sp = this.engine.player(msg.from);
                var night = isNight(this.engine.phase);
                if (sp && sp.role === ROLES.WOLF && sp.alive && night) ch = 'wolf';
                else return; // reject spoofed wolf channel
            }
            this.engine.addChat(msg.from, msg.text, ch);
            this.broadcast();
        },

        setBoard: function(id){
            if (!this.isHost || !this.engine) return;
            var r = this.engine.setBoard(id);
            if (!r.ok){ toast(r.error); return; }
            this.boardId = id;
            this.broadcast();
            this.renderAll();
        },

        start: function(){
            if (!this.isHost || !this.engine){ toast('仅房主可开局'); return; }
            var r = this.engine.startGame();
            if (!r.ok){ toast(r.error); return; }
            this.broadcast();
            showScreen('game');
            toast('游戏开始');
        },

        tickHost: function(){
            if (!this.isHost || !this.engine) return;
            if (this.engine.phase === PHASE.LOBBY) return;
            var before = this.engine.phase + '|' + this.engine.phaseDeadline;
            this.engine.tick(Date.now());
            var after = this.engine.phase + '|' + this.engine.phaseDeadline;
            if (before !== after) this.broadcast();
        },

        broadcast: function(){
            if (!this.isHost || !this.engine || !this.net) return;
            var privMap = {};
            this.engine.players.forEach(function(p){
                privMap[p.pid] = this.engine.privateState(p.pid);
            }, this);
            // public state must never carry wolf-channel messages
            var publicChat = this.engine.chat.filter(function(m){ return m.channel !== 'wolf'; });
            this.net.broadcastState(
                this.engine.publicState(),
                privMap,
                publicChat,
                this.engine.systemLog
            );
            this.public = this.engine.publicState();
            this.private = this.engine.privateState(this.myPid);
            this.chat = this.engine.chatFor(this.myPid);
            this.systemLog = this.engine.systemLog;
            this._joined = true;
            if (this.engine.phase !== PHASE.LOBBY) showScreen('game');
            else showScreen('lobby');
            $('lobby-room-code').textContent = this.net.roomCode;
            this.renderAll();
        },

        _pushSystem: function(text){
            if (this.engine) this.engine.logSystem(text);
        },

        _clientOnState: function(msg){
            this.public = msg.public;
            // prefer per-player chat from dm; fall back to public (wolf-filtered) snapshot
            if (!(this.private && this.private.chat)) this.chat = msg.chat || [];
            this.systemLog = msg.systemLog || [];
            this._joined = true;
            if (this.public && this.public.phase === PHASE.LOBBY) showScreen('lobby');
            else showScreen('game');
            $('lobby-room-code').textContent = this.net ? this.net.roomCode : '';
            this.renderAll();
        },

        sendChat: function(){
            var el = $('input-chat');
            var text = (el.value || '').trim();
            if (!text || !this.net) return;
            var ch = 'public';
            if (this.private && this.private.role === ROLES.WOLF && isNight(this.phase())){
                ch = 'wolf';
            }
            this.net.sendChat(text, ch);
            el.value = '';
        },

        sendAction: function(action){
            if (!this.net) return;
            this.net.sendAction(action);
        },

        share: function(){
            var code = this.net && this.net.roomCode;
            if (!code){ toast('尚无房间'); return; }
            var url = CFG._roomShareUrl(code);
            if (navigator.share){
                navigator.share({ title: '狼人杀', text: '房间号 ' + code, url: url }).catch(function(){});
            } else if (navigator.clipboard){
                navigator.clipboard.writeText(url).then(function(){ toast('链接已复制'); }, function(){ prompt('复制链接', url); });
            } else {
                prompt('复制链接', url);
            }
        },

        leave: function(){
            // 房主在局中离开 → 广播解散（spec: 房主断线即散局，不迁移）
            if (this.isHost && this.engine && this.net &&
                this.engine.phase !== PHASE.LOBBY && this.engine.phase !== PHASE.GAME_OVER){
                this.engine.phase = PHASE.GAME_OVER;
                this.engine.winner = this.engine.winner || null;
                this.engine.phaseDeadline = 0;
                this.engine.logSystem('房主离开，本局解散。');
                try { this.broadcast(); } catch (e) {}
            }
            if (this.net) this.net.destroy();
            this.net = null;
            this.engine = null;
            this.isHost = false;
            this._resetView();
            showScreen('home');
        },

        phase: function(){ return this.public ? this.public.phase : PHASE.LOBBY; },

        myRole: function(){
            if (this.private && this.private.role) return this.private.role;
            if (this.isHost && this.engine){
                var p = this.engine.player(this.myPid);
                return p && p.role;
            }
            return null;
        },

        renderClock: function(){
            var el = $('phase-clock');
            if (!el || !this.public || !this.public.phaseDeadline){ if (el) el.textContent = ''; return; }
            var left = Math.max(0, this.public.phaseDeadline - Date.now());
            el.textContent = Math.ceil(left / 1000) + 's';
        },

        renderAll: function(){
            if (!this.public){
                if (this.isHost && this.engine){
                    this.public = this.engine.publicState();
                    this.private = this.engine.privateState(this.myPid);
                    this.chat = this.engine.chatFor(this.myPid);
                    this.systemLog = this.engine.systemLog;
                } else {
                    return;
                }
            }
            var pub = this.public;
            var list = $('lobby-player-list');
            if (list){
                list.innerHTML = '';
                $('lobby-player-count').textContent = pub.players.length;
                var board = BOARDS[pub.boardId] || BOARDS['9'];
                $('lobby-player-max').textContent = board.size;
                pub.players.forEach(function(p){
                    var row = document.createElement('div');
                    row.className = 'player-row' + (p.pid === this.myPid ? ' me' : '');
                    row.innerHTML = '<span class="seat">#' + (p.seat + 1) + '</span><span class="pname"></span>' +
                        ((this.net && p.pid === this.net.hostPid) || (this.isHost && p.pid === this.myPid) ? '<span class="host-tag">房主</span>' : '');
                    row.querySelector('.pname').textContent = p.name;
                    list.appendChild(row);
                }, this);
                $('board-9').classList.toggle('selected', pub.boardId === '9');
                $('board-12').classList.toggle('selected', pub.boardId === '12');
                $('btn-start').disabled = !this.isHost || pub.players.length !== board.size;
                $('btn-start').classList.toggle('hidden', !this.isHost);
                $('btn-share').classList.toggle('hidden', !this.isHost);
            }

            $('phase-label').textContent = phaseLabel(pub.phase);
            $('day-label').textContent = pub.day ? ('第 ' + pub.day + ' 天') : '夜晚';
            var roleEl = $('my-role');
            var role = this.myRole();
            if (roleEl){
                roleEl.textContent = role ? ROLE_LABEL[role] : '—';
                roleEl.className = 'role-badge role-' + (role || 'none');
            }

            var privNote = $('priv-note');
            if (privNote){
                var notes = [];
                if (this.private){
                    if (this.private.role === ROLES.WOLF && this.private.wolfPeers && this.private.wolfPeers.length){
                        notes.push('狼队友：' + this.private.wolfPeers.map(function(w){ return w.name; }).join('、'));
                    }
                    if (this.private.role === ROLES.SEER && this.private.seerResults && this.private.seerResults.length){
                        var last = this.private.seerResults[this.private.seerResults.length - 1];
                        notes.push('查验 ' + last.name + '：' + (last.isWolf ? '狼人' : '好人'));
                    }
                    if (this.private.role === ROLES.WITCH){
                        notes.push('解药' + (this.private.healLeft ? '有' : '无') + ' · 毒药' + (this.private.poisonLeft ? '有' : '无'));
                        if (pub.phase === PHASE.NIGHT_WITCH && this.private.knife){
                            notes.push('今夜刀口：' + this.private.knife.name);
                        }
                    }
                    if (this.private.role === ROLES.HUNTER && pub.phase === PHASE.RESOLVE && this.private.canShoot){
                        notes.push('你可以开枪带走一人（或放弃）');
                    }
                }
                if (pub.sheriff){
                    var sp = pub.players.find(function(p){ return p.pid === pub.sheriff; });
                    notes.push('警长：' + (sp ? sp.name : pub.sheriff));
                }
                privNote.textContent = notes.join(' · ');
            }

            var seats = $('seat-grid');
            if (seats){
                seats.innerHTML = '';
                pub.players.forEach(function(p){
                    var d = document.createElement('div');
                    d.className = 'seat-card' + (!p.alive ? ' dead' : '') + (p.pid === this.myPid ? ' me' : '') + (p.sheriff ? ' sheriff' : '');
                    var mark = !p.alive ? '☠' : (p.sheriff ? '♛' : '');
                    d.innerHTML = '<div class="seat-no">' + (p.seat + 1) + '</div><div class="seat-name"></div><div class="seat-mark">' + mark + '</div>';
                    d.querySelector('.seat-name').textContent = p.name;
                    d.dataset.pid = p.pid;
                    if (this._canTarget(p)) d.addEventListener('click', this._onSeatClick.bind(this));
                    seats.appendChild(d);
                }, this);
            }

            var sys = $('system-log');
            if (sys){
                sys.innerHTML = '';
                (this.systemLog || []).slice(-30).forEach(function(line){
                    var d = document.createElement('div');
                    d.className = 'sys-line';
                    d.textContent = line.text;
                    sys.appendChild(d);
                });
                sys.scrollTop = sys.scrollHeight;
            }

            var chatBox = $('chat-log');
            if (chatBox){
                // chat is already viewer-filtered (chatFor / private.dm); only drop residual night public
                var filtered = (this.chat || []).filter(function(m){
                    if (m.channel === 'wolf') return this.myRole() === ROLES.WOLF;
                    if (isNight(pub.phase) && m.channel !== 'wolf') return false;
                    return true;
                }, this);
                chatBox.innerHTML = '';
                filtered.slice(-80).forEach(function(m){
                    var d = document.createElement('div');
                    d.className = 'chat-line' + (m.channel === 'wolf' ? ' wolf' : '');
                    d.innerHTML = '<b></b><span></span>';
                    d.querySelector('b').textContent = m.name + '：';
                    d.querySelector('span').textContent = m.text;
                    chatBox.appendChild(d);
                });
                chatBox.scrollTop = chatBox.scrollHeight;
            }

            this.renderActions(pub);

            if (pub.phase === PHASE.GAME_OVER){
                var over = $('game-over');
                if (over){
                    over.classList.remove('hidden');
                    over.textContent = pub.winner === 'wolves' ? '狼人胜利！' : '好人胜利！';
                }
            } else {
                var ov = $('game-over');
                if (ov) ov.classList.add('hidden');
            }
        },

        _canTarget: function(p){
            if (!p.alive) return false;
            if (!this.public) return false;
            if (p.pid === this.myPid) return false;
            var ph = this.public.phase;
            var role = this.myRole();
            if (ph === PHASE.NIGHT_GUARD && role === ROLES.GUARD) return true;
            if (ph === PHASE.NIGHT_WOLF && role === ROLES.WOLF) return true;
            if (ph === PHASE.NIGHT_SEER && role === ROLES.SEER) return true;
            if (ph === PHASE.NIGHT_WITCH && role === ROLES.WITCH) return true;
            if (ph === PHASE.VOTE || ph === PHASE.SHERIFF_VOTE) return true;
            if (ph === PHASE.RESOLVE && role === ROLES.HUNTER && this.private && this.private.canShoot) return true;
            return false;
        },

        _onSeatClick: function(e){
            var pid = e.currentTarget.dataset.pid;
            if (!pid) return;
            var ph = this.phase();
            var role = this.myRole();
            if (ph === PHASE.NIGHT_GUARD && role === ROLES.GUARD){
                this.sendAction({ type: 'guard', target: pid });
                toast('已选择守护目标');
                return;
            }
            if (ph === PHASE.NIGHT_WOLF && role === ROLES.WOLF){
                this.sendAction({ type: 'wolf', target: pid });
                toast('已投刀');
                return;
            }
            if (ph === PHASE.NIGHT_SEER && role === ROLES.SEER){
                this.sendAction({ type: 'seer', target: pid });
                toast('开始查验…');
                return;
            }
            if (ph === PHASE.NIGHT_WITCH && role === ROLES.WITCH){
                if (this.private && this.private.poisonLeft){
                    this.sendAction({ type: 'witch', useHeal: false, poisonTarget: pid });
                    toast('已使用毒药');
                } else {
                    toast('毒药已用完');
                }
                return;
            }
            if (ph === PHASE.VOTE){
                this.sendAction({ type: 'vote', target: pid });
                toast('已投票');
                return;
            }
            if (ph === PHASE.SHERIFF_VOTE){
                this.sendAction({ type: 'sheriffVote', target: pid });
                toast('已投警长票');
                return;
            }
            if (ph === PHASE.RESOLVE && role === ROLES.HUNTER && this.private && this.private.canShoot){
                this.sendAction({ type: 'hunter', target: pid });
                toast('开枪');
                return;
            }
        },

        witchHeal: function(){
            if (this.myRole() !== ROLES.WITCH) return;
            this.sendAction({ type: 'witch', useHeal: true, poisonTarget: null });
            toast('已使用解药');
        },

        witchSkip: function(){
            if (this.myRole() !== ROLES.WITCH) return;
            this.sendAction({ type: 'witch', useHeal: false, poisonTarget: null });
            toast('本夜不用药');
        },

        guardEmpty: function(){
            if (this.myRole() !== ROLES.GUARD) return;
            this.sendAction({ type: 'guard', target: null });
            toast('空守');
        },

        nomSelf: function(){
            if (this.public && this.public.phase === PHASE.SHERIFF_NOM){
                this.sendAction({ type: 'nominate' });
                toast('已报名竞选警长');
            }
        },

        voteSkip: function(){
            var ph = this.phase();
            if (ph === PHASE.VOTE){
                this.sendAction({ type: 'vote', target: null });
                toast('弃票');
            } else if (ph === PHASE.SHERIFF_VOTE){
                this.sendAction({ type: 'sheriffVote', target: null });
                toast('弃票');
            } else if (ph === PHASE.RESOLVE && this.myRole() === ROLES.HUNTER){
                this.sendAction({ type: 'hunter', target: null });
                toast('放弃开枪');
            }
        },

        renderActions: function(pub){
            var box = $('action-panel');
            if (!box) return;
            var role = this.myRole();
            var html = '';
            var ph = pub.phase;
            var selfAlive = pub.players.some(function(p){ return p.pid === this.myPid && p.alive; }, this);

            if (ph === PHASE.LOBBY){
                box.innerHTML = '';
                return;
            }
            if (ph === PHASE.GAME_OVER){
                box.innerHTML = '<div class="hint">对局结束，可刷新页面再来一局。</div>';
                return;
            }

            if (ph === PHASE.SHERIFF_NOM && selfAlive){
                html += '<button class="act-btn" data-act="nom">报名竞选警长</button>';
            }
            if (ph === PHASE.NIGHT_GUARD && role === ROLES.GUARD){
                html += '<div class="hint">点击一名玩家守护（不可连守）</div><button class="act-btn ghost" data-act="guard-empty">空守</button>';
            }
            if (ph === PHASE.NIGHT_WOLF && role === ROLES.WOLF){
                html += '<div class="hint">点击一名非狼玩家开刀</div>';
            }
            if (ph === PHASE.NIGHT_SEER && role === ROLES.SEER){
                html += '<div class="hint">点击一名玩家查验身份</div>';
            }
            if (ph === PHASE.NIGHT_WITCH && role === ROLES.WITCH){
                html += '<div class="hint">查看刀口后选择用药；点玩家可下毒</div>';
                if (this.private && this.private.healLeft){
                    html += '<button class="act-btn" data-act="heal">用解药救刀口</button>';
                }
                html += '<button class="act-btn ghost" data-act="witch-skip">不用药</button>';
            }
            if (ph === PHASE.VOTE){
                html += '<div class="hint">点击玩家投票放逐</div><button class="act-btn ghost" data-act="vote-skip">弃票</button>';
            }
            if (ph === PHASE.SHERIFF_VOTE){
                html += '<div class="hint">点击候选人投警长票</div><button class="act-btn ghost" data-act="vote-skip">弃票</button>';
            }
            if (ph === PHASE.RESOLVE && role === ROLES.HUNTER && this.private && this.private.canShoot){
                html += '<div class="hint">你出局了！可开枪带走一人</div><button class="act-btn ghost" data-act="vote-skip">不开枪</button>';
            }
            if (ph === PHASE.DISCUSS || ph === PHASE.SHERIFF_DISCUSS || ph === PHASE.DAWN){
                html += '<div class="hint">自由发言阶段，请用聊天框</div>';
            }

            box.innerHTML = html;
            box.querySelectorAll('[data-act]').forEach(function(btn){
                btn.onclick = function(){
                    var a = btn.getAttribute('data-act');
                    if (a === 'nom') App.nomSelf();
                    else if (a === 'guard-empty') App.guardEmpty();
                    else if (a === 'heal') App.witchHeal();
                    else if (a === 'witch-skip') App.witchSkip();
                    else if (a === 'vote-skip') App.voteSkip();
                };
            });
        }
    };

    global.WW_APP = App;
    if (document.readyState === 'loading'){
        document.addEventListener('DOMContentLoaded', function(){ App.init(); });
    } else {
        App.init();
    }
})(typeof window !== 'undefined' ? window : globalThis);
