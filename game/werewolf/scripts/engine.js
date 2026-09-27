/* engine.js — 狼人杀规则状态机（房主权威，纯逻辑，可 Node 单测） */
(function initWerewolfEngine(global){
    'use strict';

    const ROLES = {
        WOLF: 'wolf',
        SEER: 'seer',
        WITCH: 'witch',
        HUNTER: 'hunter',
        GUARD: 'guard',
        VILLAGER: 'villager'
    };

    const ROLE_LABEL = {
        wolf: '狼人',
        seer: '预言家',
        witch: '女巫',
        hunter: '猎人',
        guard: '守卫',
        villager: '平民'
    };

    const PHASE = {
        LOBBY: 'lobby',
        DEAL: 'deal',
        NIGHT_GUARD: 'night_guard',
        NIGHT_WOLF: 'night_wolf',
        NIGHT_SEER: 'night_seer',
        NIGHT_WITCH: 'night_witch',
        DAWN: 'dawn',
        SHERIFF_NOM: 'sheriff_nom',
        SHERIFF_DISCUSS: 'sheriff_discuss',
        SHERIFF_VOTE: 'sheriff_vote',
        DISCUSS: 'discuss',
        VOTE: 'vote',
        RESOLVE: 'resolve',
        GAME_OVER: 'game_over'
    };

    const BOARDS = {
        '9': {
            size: 9,
            roles: [ROLES.WOLF, ROLES.WOLF, ROLES.WOLF, ROLES.SEER, ROLES.WITCH, ROLES.HUNTER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER].slice(0, 9)
        },
        '12': {
            size: 12,
            roles: [ROLES.WOLF, ROLES.WOLF, ROLES.WOLF, ROLES.WOLF, ROLES.SEER, ROLES.WITCH, ROLES.HUNTER, ROLES.GUARD, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER]
        }
    };
    // fix 9 roles length
    BOARDS['9'].roles = [ROLES.WOLF, ROLES.WOLF, ROLES.WOLF, ROLES.SEER, ROLES.WITCH, ROLES.HUNTER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER];
    BOARDS['12'].roles = [ROLES.WOLF, ROLES.WOLF, ROLES.WOLF, ROLES.WOLF, ROLES.SEER, ROLES.WITCH, ROLES.HUNTER, ROLES.GUARD, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER];

    const DEFAULT_TIMERS = {
        night: 45000,
        sheriff_nom: 15000,
        sheriff_discuss: 60000,
        sheriff_vote: 30000,
        discuss: 120000,
        vote: 45000,
        dawn: 8000,
        deal: 5000,
        resolve: 45000
    };

    function shuffle(arr, rng){
        const a = arr.slice();
        for(let i = a.length - 1; i > 0; i--){
            const j = Math.floor(rng() * (i + 1));
            const t = a[i]; a[i] = a[j]; a[j] = t;
        }
        return a;
    }

    function defaultRng(){
        return Math.random;
    }

    class WerewolfEngine {
        constructor(opts){
            opts = opts || {};
            this.rng = opts.rng || defaultRng();
            this.timers = Object.assign({}, DEFAULT_TIMERS, opts.timers || {});
            this.boardId = opts.boardId === '12' ? '12' : '9';
            this.reset(opts.players || []);
        }

        reset(players){
            this.phase = PHASE.LOBBY;
            this.players = (players || []).map((p, i) => ({
                pid: String(p.pid),
                name: String(p.name || ('P' + (i + 1))),
                seat: i,
                alive: true,
                role: null,
                connected: p.connected !== false
            }));
            this.day = 0;
            this.phaseDeadline = 0;
            this.night = {
                guardTarget: null,
                guardPrev: null,
                wolfTarget: null,
                wolfVotes: {},
                seerTarget: null,
                seerResult: null,
                witchTarget: null,
                witchAction: null, // 'none' | 'heal' | 'poison' | 'heal+skip_poison'
                healed: false,
                poisoned: false
            };
            this.sheriff = null; // pid
            this.sheriffNoms = [];
            this.sheriffVotes = {};
            this._sheriffSkipped = false;
            this._sheriffRetried = false;
            this.dayVotes = {};
            this.lynchTarget = null;
            this.lastWill = null;
            this.winner = null; // 'wolves' | 'villagers'
            this.systemLog = [];
            this.chat = [];
            this.locked = false;
            this._pendingHunter = null;
            this.dawnDeaths = [];
            this.dawnReasons = {};
            this.private = {}; // pid -> { role, seerResults, witchHealLeft, witchPoisonLeft, wolfPeers }
            this._nomAccepted = {};
        }

        logSystem(text){
            this.systemLog.push({ t: Date.now(), text: String(text) });
            if(this.systemLog.length > 200) this.systemLog.shift();
        }

        addChat(pid, text, channel){
            const p = this.player(pid);
            if(!p) return false;
            const msg = {
                t: Date.now(),
                pid: p.pid,
                name: p.name,
                channel: channel || 'public',
                text: String(text).slice(0, 500)
            };
            this.chat.push(msg);
            if(this.chat.length > 300) this.chat.shift();
            return true;
        }

        player(pid){
            return this.players.find(p => p.pid === String(pid)) || null;
        }

        alivePlayers(){
            return this.players.filter(p => p.alive);
        }

        rolePlayers(role){
            return this.players.filter(p => p.alive && p.role === role);
        }

        canStart(){
            if(this.phase !== PHASE.LOBBY) return false;
            const board = BOARDS[this.boardId];
            return this.players.length === board.size;
        }

        startGame(){
            if(!this.canStart()) return { ok: false, error: '人数未满或状态不对' };
            const board = BOARDS[this.boardId];
            const roles = shuffle(board.roles, this.rng);
            this.players.forEach((p, i) => {
                p.role = roles[i];
                p.alive = true;
                this.private[p.pid] = {
                    role: p.role,
                    seerResults: [],
                    healLeft: p.role === ROLES.WITCH,
                    poisonLeft: p.role === ROLES.WITCH,
                    wolfPeers: this.players.filter((q, j) => j !== i && roles[j] === ROLES.WOLF).map(q => q.pid)
                };
            });
            this.locked = true;
            this.day = 0;
            this.sheriff = null;
            this.sheriffNoms = [];
            this.sheriffVotes = {};
            this.logSystem('游戏开始！身份已发放。');
            this._enterPhase(this._hasGuard() ? PHASE.NIGHT_GUARD : PHASE.NIGHT_WOLF);
            return { ok: true };
        }

        _hasGuard(){
            return this.players.some(p => p.role === ROLES.GUARD);
        }

        _timerFor(phase){
            switch(phase){
                case PHASE.DEAL: return this.timers.deal;
                case PHASE.NIGHT_GUARD:
                case PHASE.NIGHT_WOLF:
                case PHASE.NIGHT_SEER:
                case PHASE.NIGHT_WITCH: return this.timers.night;
                case PHASE.DAWN: return this.timers.dawn;
                case PHASE.SHERIFF_NOM: return this.timers.sheriff_nom;
                case PHASE.SHERIFF_DISCUSS: return this.timers.sheriff_discuss;
                case PHASE.SHERIFF_VOTE: return this.timers.sheriff_vote;
                case PHASE.DISCUSS: return this.timers.discuss;
                case PHASE.VOTE: return this.timers.vote;
                case PHASE.RESOLVE: return this.timers.resolve || 45000;
                default: return 0;
            }
        }

        _enterPhase(phase){
            this.phase = phase;
            this.phaseDeadline = Date.now() + this._timerFor(phase);
            this.dayVotes = {};
            this.lynchTarget = null;
            if(phase === PHASE.NIGHT_GUARD){
                this.night.guardTarget = null;
            }
            if(phase === PHASE.NIGHT_WOLF){
                this.night.wolfTarget = null;
                this.night.wolfVotes = {};
            }
            if(phase === PHASE.NIGHT_SEER){
                this.night.seerTarget = null;
            }
            if(phase === PHASE.NIGHT_WITCH){
                this.night.witchTarget = null;
                this.night.witchAction = null;
            }
            if(phase === PHASE.SHERIFF_NOM){
                this.sheriffNoms = [];
                this._nomAccepted = {};
            }
            if(phase === PHASE.SHERIFF_VOTE){
                this.sheriffVotes = {};
            }
            if(phase === PHASE.VOTE){
                this.dayVotes = {};
            }
        }

        /** advance timers / auto-resolve — call periodically on host */
        tick(now){
            now = now || Date.now();
            if(this.phase === PHASE.LOBBY || this.phase === PHASE.GAME_OVER) return;
            if(this.phaseDeadline && now >= this.phaseDeadline){
                this._onTimeout();
            }
        }

        _onTimeout(){
            switch(this.phase){
                case PHASE.DEAL:
                    this._enterPhase(this._hasGuard() ? PHASE.NIGHT_GUARD : PHASE.NIGHT_WOLF);
                    break;
                case PHASE.NIGHT_GUARD:
                    // empty guard
                    this._enterPhase(PHASE.NIGHT_WOLF);
                    break;
                case PHASE.NIGHT_WOLF:
                    this._resolveWolfVotes();
                    this._enterPhase(PHASE.NIGHT_SEER);
                    break;
                case PHASE.NIGHT_SEER:
                    this._enterPhase(PHASE.NIGHT_WITCH);
                    break;
                case PHASE.NIGHT_WITCH:
                    this._resolveNight();
                    break;
                case PHASE.DAWN:
                    this._afterDawn();
                    break;
                case PHASE.SHERIFF_NOM:
                    this._enterPhase(this.sheriffNoms.length >= 2 ? PHASE.SHERIFF_DISCUSS : PHASE.SHERIFF_VOTE);
                    if(this.sheriffNoms.length < 1){
                        this.logSystem('无人竞选警长，本局无警徽。');
                        this._enterPhase(PHASE.DISCUSS);
                    }
                    break;
                case PHASE.SHERIFF_DISCUSS:
                    this._enterPhase(PHASE.SHERIFF_VOTE);
                    break;
                case PHASE.SHERIFF_VOTE:
                    this._resolveSheriffVote(true);
                    break;
                case PHASE.DISCUSS:
                    this._enterPhase(PHASE.VOTE);
                    break;
                case PHASE.VOTE:
                    this._resolveVote(true);
                    break;
                case PHASE.RESOLVE:
                    // hunter timed out — skip shot so the loop cannot freeze
                    if(this._pendingHunter){
                        this.logSystem('猎人超时未开枪。');
                        this._pendingHunter = null;
                        this._checkWinOrNight();
                    }
                    break;
                default:
                    break;
            }
        }

        /**
         * Submit a player action.
         * action: { type, ... }
         */
        submitAction(pid, action){
            pid = String(pid);
            const p = this.player(pid);
            if(!p) return { ok: false, error: 'unknown player' };
            if(!action || typeof action !== 'object') return { ok: false, error: 'bad action' };
            const type = action.type;

            if(type === 'chat'){
                if(!p.alive && this.phase !== PHASE.LOBBY && this.phase !== PHASE.GAME_OVER){
                    // dead can chat in public after death only in game_over/lobby? allow dead spectate chat in discuss
                    if(this.phase !== PHASE.DISCUSS && this.phase !== PHASE.SHERIFF_DISCUSS) return { ok: false, error: '死者暂不可发言' };
                }
                if(this.phase === PHASE.NIGHT_GUARD || this.phase === PHASE.NIGHT_WOLF || this.phase === PHASE.NIGHT_SEER || this.phase === PHASE.NIGHT_WITCH){
                    // night: only wolves chat on wolf channel
                    if(action.channel === 'wolf' || action.channel === 'public'){
                        if(p.role !== ROLES.WOLF || !p.alive) return { ok: false, error: '夜间禁言' };
                        this.addChat(pid, action.text, 'wolf');
                        return { ok: true };
                    }
                }
                const ch = action.channel === 'wolf' && p.role === ROLES.WOLF ? 'wolf' : 'public';
                this.addChat(pid, action.text, ch);
                return { ok: true };
            }

            if(this.phase === PHASE.LOBBY){
                return { ok: false, error: 'lobby' };
            }
            if(this.phase === PHASE.GAME_OVER){
                return { ok: false, error: 'over' };
            }
            // dead players may still act only for hunter resolve (and chat handled above)
            const hunterResolve = this.phase === PHASE.RESOLVE && this._pendingHunter === pid;
            if(!p.alive && type !== 'chat' && !hunterResolve){
                return { ok: false, error: '出局玩家不能操作' };
            }

            switch(this.phase){
                case PHASE.NIGHT_GUARD:
                    return this._actGuard(p, action);
                case PHASE.NIGHT_WOLF:
                    return this._actWolf(p, action);
                case PHASE.NIGHT_SEER:
                    return this._actSeer(p, action);
                case PHASE.NIGHT_WITCH:
                    return this._actWitch(p, action);
                case PHASE.SHERIFF_NOM:
                    return this._actNom(p, action);
                case PHASE.SHERIFF_VOTE:
                    return this._actSheriffVote(p, action);
                case PHASE.VOTE:
                    return this._actVote(p, action);
                case PHASE.RESOLVE:
                    return this._actHunter(p, action);
                default:
                    return { ok: false, error: 'phase ' + this.phase };
            }
        }

        _actGuard(p, action){
            if(p.role !== ROLES.GUARD) return { ok: false, error: '需要守卫' };
            const target = action.target == null || action.target === '' ? null : String(action.target);
            if(target){
                if(target === p.pid) return { ok: false, error: '不能守自己' };
                const t = this.player(target);
                if(!t || !t.alive) return { ok: false, error: '目标无效' };
                if(this.night.guardPrev && this.night.guardPrev === target){
                    return { ok: false, error: '不能连守同一人' };
                }
            }
            this.night.guardTarget = target;
            // auto-advance if all guards acted (only one guard)
            this._enterPhase(PHASE.NIGHT_WOLF);
            return { ok: true };
        }

        _actWolf(p, action){
            if(p.role !== ROLES.WOLF) return { ok: false, error: '需要狼人' };
            const target = String(action.target || '');
            const t = this.player(target);
            if(!t || !t.alive) return { ok: false, error: '目标无效' };
            if(t.role === ROLES.WOLF) return { ok: false, error: '不能刀狼队友' };
            this.night.wolfVotes[p.pid] = target;
            const wolves = this.rolePlayers(ROLES.WOLF);
            const allDone = wolves.every(w => this.night.wolfVotes[w.pid]);
            if(allDone){
                this._resolveWolfVotes();
                this._enterPhase(PHASE.NIGHT_SEER);
            }
            return { ok: true };
        }

        /** tally wolf votes; tie → random among top (spec: 平票随机) */
        _resolveWolfVotes(){
            const votes = Object.values(this.night.wolfVotes);
            if(votes.length){
                const counts = {};
                votes.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
                let bestN = -1;
                let bests = [];
                Object.keys(counts).forEach(k => {
                    if(counts[k] > bestN){ bestN = counts[k]; bests = [k]; }
                    else if(counts[k] === bestN) bests.push(k);
                });
                this.night.wolfTarget = bests[Math.floor(this.rng() * bests.length)];
            } else {
                const victims = this.alivePlayers().filter(p => p.role !== ROLES.WOLF);
                this.night.wolfTarget = victims.length ? victims[Math.floor(this.rng() * victims.length)].pid : null;
            }
        }

        _actSeer(p, action){
            if(p.role !== ROLES.SEER) return { ok: false, error: '需要预言家' };
            const target = String(action.target || '');
            if(target === p.pid) return { ok: false, error: '不能查自己' };
            const t = this.player(target);
            if(!t) return { ok: false, error: '目标无效' };
            this.night.seerTarget = target;
            const isWolf = t.role === ROLES.WOLF;
            this.night.seerResult = { target, isWolf, name: t.name };
            const priv = this.private[p.pid] || (this.private[p.pid] = { seerResults: [] });
            priv.seerResults = priv.seerResults || [];
            priv.seerResults.push({ day: this.day, target, name: t.name, isWolf });
            this._enterPhase(PHASE.NIGHT_WITCH);
            return { ok: true, result: { isWolf, name: t.name } };
        }

        _actWitch(p, action){
            if(p.role !== ROLES.WITCH) return { ok: false, error: '需要女巫' };
            const priv = this.private[p.pid] || {};
            const knife = this.night.wolfTarget;
            const useHeal = !!action.useHeal;
            const poisonTarget = action.poisonTarget ? String(action.poisonTarget) : null;

            if(useHeal && !priv.healLeft) return { ok: false, error: '解药已用完' };
            if(poisonTarget && !priv.poisonLeft) return { ok: false, error: '毒药已用完' };
            if(useHeal && poisonTarget) return { ok: false, error: '同夜至多用一瓶药' };
            if(useHeal && !knife) return { ok: false, error: '今夜无人被刀' };
            if(poisonTarget){
                const t = this.player(poisonTarget);
                if(!t || !t.alive) return { ok: false, error: '毒药目标无效' };
                if(t.pid === p.pid) return { ok: false, error: '不能毒自己' };
            }

            this.night.healed = !!useHeal;
            this.night.poisoned = !!poisonTarget;
            this.night.witchTarget = poisonTarget;
            if(useHeal) priv.healLeft = false;
            if(poisonTarget) priv.poisonLeft = false;
            this.private[p.pid] = priv;
            this._resolveNight();
            return { ok: true };
        }

        _resolveNight(){
            const knife = this.night.wolfTarget;
            const guarded = this.night.guardTarget;
            let died = [];
            let deathReasons = {};

            const knifeBlocked = knife && guarded && knife === guarded;
            if(knife && !knifeBlocked && !this.night.healed){
                died.push(knife);
                deathReasons[knife] = 'wolf';
            } else if(knife && knifeBlocked){
                this.logSystem('昨夜袭击被守卫挡下。');
            } else if(knife && this.night.healed){
                this.logSystem('昨夜有人被女巫救起。');
            }

            if(this.night.poisoned && this.night.witchTarget){
                if(died.indexOf(this.night.witchTarget) < 0){
                    died.push(this.night.witchTarget);
                    deathReasons[this.night.witchTarget] = 'poison';
                }
            }

            // unique
            died = Array.from(new Set(died));
            this.night.guardPrev = this.night.guardTarget;

            if(!died.length){
                this.logSystem('昨夜是平安夜。');
            } else {
                died.forEach(pid => {
                    const t = this.player(pid);
                    if(t && t.alive){
                        t.alive = false;
                        const reason = deathReasons[pid] || 'unknown';
                        this.logSystem(t.name + ' 昨夜死亡（' + (reason === 'poison' ? '毒药' : '狼人袭击') + '）。');
                        this.lastWill = { pid, reason };
                    }
                });
            }

            this.dawnDeaths = died;
            this.dawnReasons = deathReasons;
            this._enterPhase(PHASE.DAWN);
        }

        _afterDawn(){
            // hunter check on night deaths (not poisoned)
            const hunterDeath = (this.dawnDeaths || []).find(pid => {
                const p = this.player(pid);
                return p && p.role === ROLES.HUNTER && this.dawnReasons[pid] !== 'poison';
            });
            if(hunterDeath){
                this._pendingHunter = hunterDeath;
                this._enterPhase(PHASE.RESOLVE);
                return;
            }
            this._enterDayFlow();
        }

        _enterDayFlow(){
            const win = this._checkWin();
            if(win) return;
            this.day += 1;
            if(this.day === 1 && this.sheriff === null && !this._sheriffSkipped){
                this._enterPhase(PHASE.SHERIFF_NOM);
                this.logSystem('第 ' + this.day + ' 天：警长竞选（报名）');
                return;
            }
            this._enterPhase(PHASE.DISCUSS);
            this.logSystem('第 ' + this.day + ' 天：讨论开始');
        }

        _actNom(p, action){
            if(action.type !== 'nominate') return { ok: false, error: 'bad' };
            if(this._nomAccepted[p.pid]) return { ok: false, error: '已报名' };
            this._nomAccepted[p.pid] = true;
            this.sheriffNoms.push(p.pid);
            return { ok: true };
        }

        _actSheriffVote(p, action){
            if(!this.sheriffNoms.length) return { ok: false, error: '无人竞选' };
            const target = action.target == null ? null : String(action.target);
            if(target && this.sheriffNoms.indexOf(target) < 0) return { ok: false, error: '只能投候选人' };
            this.sheriffVotes[p.pid] = target; // null = 弃票
            const voters = this.alivePlayers();
            if(voters.every(v => this.sheriffVotes[v.pid] !== undefined)){
                this._resolveSheriffVote(false);
            }
            return { ok: true };
        }

        _resolveSheriffVote(timedOut){
            const counts = {};
            this.sheriffNoms.forEach(n => { counts[n] = 0; });
            Object.keys(this.sheriffVotes).forEach(voter => {
                const t = this.sheriffVotes[voter];
                if(t && counts[t] !== undefined) counts[t] += 1;
            });

            let best = null, bestN = -1, tie = false;
            this.sheriffNoms.forEach(n => {
                if(counts[n] > bestN){ bestN = counts[n]; best = n; tie = false; }
                else if(counts[n] === bestN && counts[n] >= 0) tie = true;
            });
            // recompute tie properly
            best = null; bestN = -1;
            this.sheriffNoms.forEach(n => { if(counts[n] > bestN){ bestN = counts[n]; best = n; } });
            tie = this.sheriffNoms.filter(n => counts[n] === bestN).length > 1;

            if(timedOut && bestN <= 0 && !this._sheriffRetried){
                this._sheriffRetried = true;
                this.logSystem('警长竞选无人得票，重新竞选一次。');
                this._enterPhase(PHASE.SHERIFF_NOM);
                return;
            }
            if(timedOut && bestN <= 0){
                this._sheriffSkipped = true;
                this.logSystem('警长竞选超时，无警徽。');
                this._enterDayFlowAfterSheriff();
                return;
            }
            // 平票 → 重竞选一次；再平 → 无警徽（spec）
            if(tie || bestN <= 0){
                if(!this._sheriffRetried){
                    this._sheriffRetried = true;
                    this.logSystem('警长竞选平票，重新竞选一次。');
                    this._enterPhase(PHASE.SHERIFF_NOM);
                    return;
                }
                this._sheriffSkipped = true;
                this.logSystem('警长竞选再次平票，本局无警徽。');
                this._enterDayFlowAfterSheriff();
                return;
            }
            this.sheriff = best;
            const p = this.player(best);
            this.logSystem((p ? p.name : best) + ' 当选警长。');
            this._enterDayFlowAfterSheriff();
        }

        _enterDayFlowAfterSheriff(){
            const win = this._checkWin();
            if(win) return;
            this._enterPhase(PHASE.DISCUSS);
            this.logSystem('讨论开始' + (this.day ? '（第 ' + Math.max(this.day, 1) + ' 天）' : ''));
        }

        _actVote(p, action){
            const target = action.target == null || action.target === '' ? null : String(action.target);
            if(target){
                const t = this.player(target);
                if(!t || !t.alive) return { ok: false, error: '目标无效' };
                if(t.pid === p.pid) return { ok: false, error: '不能投自己' };
            }
            this.dayVotes[p.pid] = target;
            const voters = this.alivePlayers();
            if(voters.every(v => this.dayVotes[v.pid] !== undefined)){
                this._resolveVote(false);
            }
            return { ok: true };
        }

        _countVotes(votes, weightOf){
            const counts = {};
            Object.keys(votes).forEach(voter => {
                const t = votes[voter];
                if(!t) return;
                const w = weightOf ? weightOf(voter) : 1;
                counts[t] = (counts[t] || 0) + w;
            });
            return counts;
        }

        _resolveVote(timedOut){
            const counts = this._countVotes(this.dayVotes, voter => (voter === this.sheriff ? 2 : 1));
            let best = null, bestN = -1, tie = false;
            Object.keys(counts).forEach(k => {
                if(counts[k] > bestN){ bestN = counts[k]; best = k; tie = false; }
                else if(counts[k] === bestN) tie = true;
            });
            if(timedOut && bestN <= 0){
                this.logSystem('投票超时，无人被放逐。');
                this._endDayNoLynch();
                return;
            }
            if(tie || bestN <= 0){
                this.logSystem('平票或无人得票，今天无人被放逐。');
                this._endDayNoLynch();
                return;
            }
            const t = this.player(best);
            if(!t || !t.alive){
                this._endDayNoLynch();
                return;
            }
            t.alive = false;
            this.lynchTarget = best;
            this.logSystem(t.name + ' 被投票放逐。');
            if(t.role === ROLES.HUNTER){
                this._pendingHunter = best;
                this._enterPhase(PHASE.RESOLVE);
                return;
            }
            this._checkWinOrNight();
        }

        _endDayNoLynch(){
            this._checkWinOrNight();
        }

        _actHunter(p, action){
            if(this._pendingHunter !== p.pid) return { ok: false, error: '不是猎人结算' };
            const target = action.target == null || action.target === '' ? null : String(action.target);
            if(target){
                const t = this.player(target);
                if(!t || !t.alive) return { ok: false, error: '目标无效' };
                t.alive = false;
                this.logSystem(p.name + ' 开枪带走了 ' + t.name + '。');
            } else {
                this.logSystem(p.name + ' 放弃开枪。');
            }
            this._pendingHunter = null;
            this._checkWinOrNight();
            return { ok: true };
        }

        _hunterCanShoot(pid){
            const p = this.player(pid);
            if(!p || p.role !== ROLES.HUNTER) return false;
            // poison death cannot shoot — tracked via lastWill reason
            if(this.lastWill && this.lastWill.pid === pid && this.lastWill.reason === 'poison') return false;
            return p.alive === false; // dead hunter resolving
        }

        _checkWin(){
            const wolves = this.players.filter(p => p.role === ROLES.WOLF && p.alive).length;
            const good = this.players.filter(p => p.role !== ROLES.WOLF && p.alive).length;
            if(wolves === 0){
                this.winner = 'villagers';
                this.phase = PHASE.GAME_OVER;
                this.phaseDeadline = 0;
                this.logSystem('好人胜利！狼人已全灭。');
                return true;
            }
            if(wolves >= good){
                this.winner = 'wolves';
                this.phase = PHASE.GAME_OVER;
                this.phaseDeadline = 0;
                this.logSystem('狼人胜利！（屠边/人数优势）');
                return true;
            }
            return false;
        }

        _checkWinOrNight(){
            if(this._checkWin()) return;
            // next night
            this.night = {
                guardTarget: null,
                guardPrev: this.night.guardPrev,
                wolfTarget: null,
                wolfVotes: {},
                seerTarget: null,
                seerResult: null,
                witchTarget: null,
                witchAction: null,
                healed: false,
                poisoned: false
            };
            this._enterPhase(this._hasGuardAlive() ? PHASE.NIGHT_GUARD : PHASE.NIGHT_WOLF);
            this.logSystem('夜幕降临…');
        }

        _hasGuardAlive(){
            return this.players.some(p => p.alive && p.role === ROLES.GUARD);
        }

        setBoard(boardId){
            if(this.phase !== PHASE.LOBBY) return { ok: false, error: '仅大厅可换板' };
            if(boardId !== '9' && boardId !== '12') return { ok: false, error: '未知板子' };
            this.boardId = boardId;
            return { ok: true };
        }

        /** Public state for a viewer (or null for pure public) */
        publicState(){
            const phase = this.phase;
            const needPrivatePhase = (
                phase === PHASE.NIGHT_GUARD || phase === PHASE.NIGHT_WOLF ||
                phase === PHASE.NIGHT_SEER || phase === PHASE.NIGHT_WITCH
            );
            return {
                phase,
                day: this.day,
                boardId: this.boardId,
                locked: this.locked,
                winner: this.winner,
                sheriff: this.sheriff,
                phaseDeadline: this.phaseDeadline,
                players: this.players.map(p => ({
                    pid: p.pid,
                    name: p.name,
                    seat: p.seat,
                    alive: p.alive,
                    connected: p.connected,
                    // hide roles unless game over or viewer should see own via private
                    role: this.phase === PHASE.GAME_OVER ? p.role : undefined,
                    sheriff: this.sheriff === p.pid
                })),
                systemLog: this.systemLog.slice(-80),
                // chat filtered by phase for wolves-only night handled in net layer per viewer
                nightKnifeVisible: phase === PHASE.DAWN || phase === PHASE.GAME_OVER ? this.night.wolfTarget : undefined,
                pendingHunter: this._pendingHunter || null,
                sheriffNoms: phase === PHASE.SHERIFF_VOTE || phase === PHASE.SHERIFF_DISCUSS ? this.sheriffNoms : undefined,
                voteCounts: (phase === PHASE.RESOLVE || phase === PHASE.GAME_OVER) ? this._countVotes(this.dayVotes, v => (v === this.sheriff ? 2 : 1)) : undefined,
                rolesBoard: this.phase === PHASE.LOBBY ? this._boardComposition() : undefined
            };
        }

        _boardComposition(){
            const roles = BOARDS[this.boardId].roles;
            const c = {};
            roles.forEach(r => { c[r] = (c[r] || 0) + 1; });
            return c;
        }

        privateState(pid){
            pid = String(pid);
            const p = this.player(pid);
            if(!p) return null;
            const priv = this.private[pid] || {};
            const out = {
                pid: p.pid,
                role: p.role,
                alive: p.alive,
                seerResults: priv.seerResults || [],
                healLeft: priv.healLeft,
                poisonLeft: priv.poisonLeft,
                wolfPeers: p.role === ROLES.WOLF
                    ? this.players.filter(x => x.role === ROLES.WOLF && x.pid !== pid).map(x => ({ pid: x.pid, name: x.name }))
                    : undefined
            };
            if(this.phase === PHASE.NIGHT_WITCH && p.role === ROLES.WITCH){
                out.knife = this.night.wolfTarget ? {
                    pid: this.night.wolfTarget,
                    name: (this.player(this.night.wolfTarget) || {}).name
                } : null;
            }
            if(this.phase === PHASE.RESOLVE && this._pendingHunter === pid){
                out.canShoot = this._hunterCanShoot(pid) || p.alive === false;
                // if poisoned, canShoot false — but hunter who was lynched can shoot
                if(p.role === ROLES.HUNTER){
                    const poisoned = this.lastWill && this.lastWill.pid === pid && this.lastWill.reason === 'poison';
                    // lynch hunter always can shoot; night hunter only if not poison
                    const wasLynched = this.lynchTarget === pid;
                    out.canShoot = wasLynched || !poisoned;
                }
            }
            // per-viewer chat (wolf channel + night filter) — never put full chat on public state
            out.chat = this.chatFor(pid);
            return out;
        }

        chatFor(pid){
            pid = String(pid);
            const p = this.player(pid);
            const night = this.phase === PHASE.NIGHT_GUARD || this.phase === PHASE.NIGHT_WOLF ||
                this.phase === PHASE.NIGHT_SEER || this.phase === PHASE.NIGHT_WITCH;
            return this.chat.filter(m => {
                if(m.channel === 'wolf'){
                    return p && p.role === ROLES.WOLF;
                }
                if(night) return false;
                return true;
            }).slice(-120);
        }

        /** serialize for network */
        snapshot(){
            return {
                public: this.publicState(),
                chat: this.chat,
                systemLog: this.systemLog
            };
        }
    }

    const api = {
        WerewolfEngine,
        ROLES,
        ROLE_LABEL,
        PHASE,
        BOARDS,
        DEFAULT_TIMERS
    };

    if(typeof module !== 'undefined' && module.exports){
        module.exports = api;
    }
    global.WW_ENGINE = api;
    if(global) global.WerewolfEngine = WerewolfEngine;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
