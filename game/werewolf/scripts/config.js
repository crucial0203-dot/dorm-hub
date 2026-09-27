(function initWerewolfConfig(global){
    'use strict';

    var _loc = null;
    try { _loc = (typeof location !== 'undefined') ? location : null; } catch (e) { _loc = null; }

    var BASE_URL = '';
    if (_loc && typeof _loc.origin === 'string' && /^https?:\/\//i.test(_loc.origin)) {
        var base = _loc.origin + (_loc.pathname || '/');
        base = base.replace(/\/[^/]*\.html?$/i, '/');
        base = base.replace(/\/+$/, '') + '/';
        BASE_URL = base;
    } else {
        BASE_URL = 'https://7o74rwwcytn5z.space.mcode.cn/game/werewolf/';
    }

    var BROKER_SELECTION_STORAGE_KEY = 'ww_broker_selection';
    var NAME_STORAGE_KEY = 'ww_player_name';

    var NET_CONFIG = {
        connectTimeoutMs: 12000,
        heartbeatIntervalMs: 10000,
        heartbeatTimeoutMs: 30000,
        brokerCandidates: [
            { url: 'wss://broker-cn.emqx.io:8084/mqtt', subprotocol: 'mqtt', label: 'EMQX 国内节点 (默认)' },
            { url: 'wss://broker.emqx.io:8084/mqtt', subprotocol: 'mqtt', label: 'EMQX 国际节点' },
            { url: 'wss://test.mosquitto.org:8081/mqtt', subprotocol: 'mqtt', label: 'Mosquitto 测试 broker' },
            { url: 'wss://broker.hivemq.com:8884/mqtt', subprotocol: 'mqtt', label: 'HiveMQ 公共 broker' }
        ]
    };

    function _readBrokerSelection(){
        try {
            var stored = localStorage.getItem(BROKER_SELECTION_STORAGE_KEY);
            if (stored !== null) {
                var idx = parseInt(stored, 10);
                if (Number.isFinite(idx) && idx >= 0 && idx < NET_CONFIG.brokerCandidates.length) {
                    return idx;
                }
            }
        } catch (e) {}
        return 0;
    }

    function _setBrokerSelection(idx){
        try { localStorage.setItem(BROKER_SELECTION_STORAGE_KEY, String(idx)); } catch (e) {}
    }

    function _readName(){
        try { return localStorage.getItem(NAME_STORAGE_KEY) || ''; } catch (e) { return ''; }
    }

    function _saveName(name){
        try { localStorage.setItem(NAME_STORAGE_KEY, String(name || '').slice(0, 12)); } catch (e) {}
    }

    function _applyBrokerFromUrl(){
        var raw = null;
        try {
            var params = new URLSearchParams(window.location.search);
            raw = params.get('broker');
            if (raw == null && window.location.hash && window.location.hash.indexOf('broker=') >= 0) {
                raw = window.location.hash.split('broker=')[1];
                if (raw) raw = raw.split('&')[0];
            }
        } catch (e) { raw = null; }
        if (raw == null) return;
        var idx = parseInt(String(raw), 10);
        var n = NET_CONFIG.brokerCandidates.length;
        if (Number.isFinite(idx) && idx >= 0 && idx < n) {
            _setBrokerSelection(idx);
        }
    }

    function _roomShareUrl(code){
        var b = _readBrokerSelection() || 0;
        return BASE_URL + '?room=' + encodeURIComponent(code) + '&broker=' + b;
    }

    function _readRoomFromUrl(){
        try {
            var params = new URLSearchParams(window.location.search);
            var code = params.get('room');
            if (!code && window.location.hash && window.location.hash.indexOf('room=') >= 0) {
                code = window.location.hash.split('room=')[1];
                if (code) code = code.split(/[&#]/)[0];
            }
            if (code) return String(code).trim().toUpperCase().substring(0, 4);
        } catch (e) {}
        return null;
    }

    global.WW_CONFIG = {
        BASE_URL: BASE_URL,
        NET_CONFIG: NET_CONFIG,
        BROKER_SELECTION_STORAGE_KEY: BROKER_SELECTION_STORAGE_KEY,
        _readBrokerSelection: _readBrokerSelection,
        _setBrokerSelection: _setBrokerSelection,
        _readName: _readName,
        _saveName: _saveName,
        _applyBrokerFromUrl: _applyBrokerFromUrl,
        _roomShareUrl: _roomShareUrl,
        _readRoomFromUrl: _readRoomFromUrl
    };
})(typeof window !== 'undefined' ? window : globalThis);
