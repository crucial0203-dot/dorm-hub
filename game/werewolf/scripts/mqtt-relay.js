/* =============================================================================
 * mqtt-relay.js — 最小 MQTT 3.1.1 客户端 (浏览器端)
 * -----------------------------------------------------------------------------
 * 用途：作为狼人杀 的中央中继传输层，替代 PeerJS/WebRTC P2P，从根本绕开
 *      NAT 打洞。客户端各自连公共 broker (broker.emqx.io)，消息由 broker pub/sub
 *      转发，无需任一客户端"被建立直连"。
 *
 * 依赖：原生 WebSocket (必须传 subprotocol 'mqtt')。无任何第三方库。
 *
 * 对外 API (global.WW_MQTT_RELAY.MQTTClient)：
 *   new MQTTClient({ url, clientId, onOpen, onMessage, onClose, onError })
 *     .connect()                  // 建立连接并开始心跳
 *     .subscribe(topic, qos=0)    // 订阅 (可多次)
 *     .publish(topic, payload)    // 发布 (payload 自动 JSON 序列化)
 *     .destroy()                  // 关闭连接
 *   onMessage({ topic, payload })
 *
 * 重连：指数退避 (2s → 4s → ... 上限 30s)，断线自动重连并自动重订阅。
 * ===========================================================================*/
(function initMqttRelay(global){
    'use strict';

    const REM_LEN_MAX = 4;

    // ------- 字节工具 -------
    function b(bytes){ return new Uint8Array(bytes); }
    function u8(n){ return b([n & 0xff]); }
    function u16(n){ const x=b(2); x[0]=(n>>8)&0xff; x[1]=n&0xff; return x; }
    function remLen(n){
        const out=[];
        do{
            let d=n%128; n=(n-(n%128))/128;
            if(n>0) d|=0x80;
            out.push(d);
        }while(n>0 && out.length<REM_LEN_MAX);
        return b(out);
    }
    function concatBytes(...parts){
        const total=parts.reduce((s,p)=>s+p.length,0);
        const out=new Uint8Array(total);
        let o=0;
        for(const p of parts){ out.set(p,o); o+=p.length; }
        return out;
    }
    function encStr(s){
        const raw=new TextEncoder().encode(s);
        return concatBytes(u16(raw.length), raw);
    }
    function pkt(type, remaining){ return concatBytes(u8(type), remLen(remaining.length), remaining); }

    // ------- 控制报文构造 -------
    function buildConnect(clientId){
        // CONNECT, clean session, keepalive 60, protocol MQTT 3.1.1
        const payload = concatBytes(
            encStr('MQTT'), u8(0x04),
            u8(0x02),          // connect flags
            u16(60),           // keepalive
            encStr(clientId)
        );
        return pkt(0x10, payload);
    }
    function buildSubscribe(id, topic){
        // SUBSCRIBE, qos 0
        const payload = concatBytes(u16(id), encStr(topic), u8(0x00));
        return pkt(0x82, payload);
    }
    function buildPublishQos0(topic, bytes){
        const payload = concatBytes(encStr(topic), bytes);
        return pkt(0x30, payload);
    }
    function buildPing(){ return pkt(0xC0, b([])); }

    // ------- 增量解析 PUBLISH message (event.data 不一定整包到达，做缓冲) -------
    class Reader {
        constructor(){ this.buf=b([]); }
        push(data){
            const arr=(data instanceof Uint8Array)
                ? data
                : (data instanceof ArrayBuffer ? new Uint8Array(data) : new TextEncoder().encode(String(data)));
            this.buf=concatBytes(this.buf, arr);
        }
        // 尝试读出一个完整 PUBLISH 报文；不足返回 null
        next(){
            if(this.buf.length<2) return null;
            // remaining length 变长编码
            let rem=0, mult=1, i=1, cont=true, remLenBytes=0;
            do{
                if(i>=this.buf.length) return null;
                const d=this.buf[i];
                rem += (d&0x7f)*mult; mult*=128; i++;
                remLenBytes++;
                cont=!!(d&0x80);
            }while(cont && remLenBytes<4);
            if(this.buf.length < 1+remLenBytes+rem) return null; // 等更多数据
            const body=this.buf.slice(1+remLenBytes, 1+remLenBytes+rem);
            const head=this.buf.slice(0, 1+remLenBytes+rem);
            // 从缓冲区移除
            this.buf=this.buf.slice(1+remLenBytes+rem);
            return { head, body };
        }
    }

    class MQTTClient {
        constructor(opts){
            this.url=opts.url || 'wss://broker.emqx.io:8084/mqtt';
            this.subprotocol=opts.subprotocol || 'mqtt';
            this.clientId=opts.clientId || ('ww-'+Math.random().toString(36).slice(2,10));
            this.onOpen=opts.onOpen||null;
            this.onMessage=opts.onMessage||null;
            this.onClose=opts.onClose||null;
            this.onError=opts.onError||null;
            this.ws=null; this.opened=false; this.destroyed=false;
            this.state='idle'; // 'idle' | 'connecting' | 'open' | 'closed' | 'failed'
            this.lastError=null;
            this.pingTimer=null; this.reconnectDelay=2000;
            this.topics=[]; // 已订阅主题，重连时自动重订阅
            this.reader=new Reader();
            this._subIdCounter=0;
        }

        connect(){
            if(this.destroyed) return;
            this.state='connecting'; this.lastError=null;
            try{
                this.ws=new WebSocket(this.url, [ this.subprotocol ]);
            }catch(e){
                this.state='failed'; this.lastError=e.message||String(e);
                if(this.onError) this.onError(e);
                this._scheduleReconnect();
                return;
            }
            this.ws.binaryType='arraybuffer';
            this.ws.onopen=()=>{
                try{ this.ws.send(buildConnect(this.clientId).buffer); }
                catch(e){ this.state='failed'; this.lastError=e.message; if(this.onError)this.onError(e); }
            };
            this.ws.onmessage=(ev)=>{
                let data;
                if(typeof ev.data==='string') data=new TextEncoder().encode(ev.data);
                else if(ev.data instanceof ArrayBuffer) data=new Uint8Array(ev.data);
                else if(ev.data instanceof Blob) return; // arraybuffer 模式下不会出现
                else data=new TextEncoder().encode(String(ev.data));
                this._onBytes(data);
            };
            this.ws.onerror=(ev)=>{
                this.state='failed';
                this.lastError='websocket error';
                if(this.onError) this.onError(new Error('websocket error'));
            };
            this.ws.onclose=(ev)=>{
                this.opened=false; this._stopPing();
                // CONNACK 失败路径先置 failed 再 close — 不得被 onclose 覆盖成 reconnect 态
                if(this.state!=='failed'){
                    this.state=this.destroyed?'closed':'closed-reconnect';
                    if(!this.destroyed) this._scheduleReconnect();
                }
                if(this.onClose && ev) this.onClose({code:ev.code});
            };
        }

        _scheduleReconnect(){
            if(this.destroyed||this.opened) return;
            const delay=this.reconnectDelay;
            this.reconnectDelay=Math.min(this.reconnectDelay*2, 30000);
            setTimeout(()=>{ if(!this.destroyed&&!this.opened) this.connect(); }, delay);
        }

        _onBytes(data){
            const frames=this.reader.push(data);
            // 简单处理：每次消息按"可能是 1 或多个控制报文"解析
            // 实际上 event.data 通常就是整包，这里统一走 Reader 拆帧
            const parsed=this._drain();
            for(const f of parsed) this._handleFrame(f.head[0], f.body);
        }

        _drain(){
            const out=[];
            while(true){
                const f=this.reader.next();
                if(!f) break;
                out.push(f);
            }
            return out;
        }

        _handleFrame(type, body){
            const t=type & 0xf0;
            if(t===0x20){ // CONNACK
                const isOk=(body[1]===0);
                if(isOk){
                    this.opened=true; this.state='open'; this.lastError=null;
                    this.reconnectDelay=2000;
                    this._startPing();
                    this._resubscribeAll(); // 补发 open 前订阅的主题
                    if(this.onOpen) this.onOpen();
                } else {
                    // broker 拒绝: 绝不 onOpen — 上层必须把这次当成失败
                    this.opened=false; this.state='failed'; this.lastError='CONNACK code '+body[1];
                    if(this.onError) this.onError(new Error(this.lastError));
                    try{ if(this.ws) this.ws.close(); }catch(e){}
                }
            }
            else if(t===0x90){ /* SUBACK - 忽略（乐观订阅） */ }
            else if(t===0x30){ // PUBLISH
                let i=0;
                const tl=(body[i]<<8)|body[i+1]; i+=2;
                const topic=new TextDecoder().decode(body.subarray(i,i+tl)); i+=tl;
                // QoS0: 无 packet id，payload 从 i 开始
                const payloadBytes=body.subarray(i);
                const payload=new TextDecoder().decode(payloadBytes);
                if(this.onMessage){
                    let obj=payload;
                    try{ obj=JSON.parse(payload); }catch(e){ /* 保留字符串 */ }
                    this.onMessage({ topic, payload:obj });
                }
            }
            else if(t===0xD0){ /* PINGRESP */ }
        }

        subscribe(topic, qos){
            if(typeof qos==='undefined') qos=0;
            if(this.topics.indexOf(topic)<0) this.topics.push(topic);
            if(this.opened && this.ws && this.ws.readyState===WebSocket.OPEN){
                this._subIdCounter++;
                try{ this.ws.send(buildSubscribe(this._subIdCounter, topic).buffer); }catch(e){}
            }
        }

        _resubscribeAll(){
            if(!this.opened||!this.ws) return;
            for(const t of this.topics){
                this._subIdCounter++;
                try{ this.ws.send(buildSubscribe(this._subIdCounter, t).buffer); }catch(e){}
            }
        }

        publish(topic, payload){
            const bytes=(typeof payload==='string')
                ? new TextEncoder().encode(payload)
                : new TextEncoder().encode(JSON.stringify(payload));
            if(this.opened && this.ws && this.ws.readyState===WebSocket.OPEN){
                try{ this.ws.send(buildPublishQos0(topic, bytes).buffer); }catch(e){ if(this.onError)this.onError(e); }
            }
        }

        _startPing(){
            this._stopPing();
            this.pingTimer=setInterval(()=>{
                try{ if(this.ws && this.ws.readyState===WebSocket.OPEN) this.ws.send(buildPing().buffer); }catch(e){}
            }, 20000); // keepalive 60，20s ping 更稳
        }
        _stopPing(){ if(this.pingTimer){ clearInterval(this.pingTimer); this.pingTimer=null; } }

        destroy(){
            this.destroyed=true; this._stopPing();
            try{ if(this.ws){ this.ws.onclose=null; this.ws.close(); } }catch(e){}
            this.ws=null; this.opened=false;
        }
    }

    global.WW_MQTT_RELAY={ MQTTClient };
})(typeof window!=='undefined'?window:globalThis);