/* =============================================================================
 * broker-status.js — MQTT broker 状态/切换浮动小角标
 * -----------------------------------------------------------------------------
 * 目的:
 *   让用户可视化看到当前 broker 连接状态, 提供备选 broker 切换入口
 *   应对"无法同步"场景: 不同运营商/网络对不同 broker 的可达性差异极大
 *
 * 位置: 屏幕右下角, 不阻塞游戏
 * 显示: 圆点 + 文字 (当前 broker 简称 + 状态)
 * 点击: 弹出面板 (备选 broker 列表 + 测速按钮 + 切换 + 持久化)
 *
 * 切换流程:
 *   用户选 broker B → 保存 index 到 localStorage → location.reload()
 *   刷新后 runtime-config 读取新选择 → network-manager 用 B 的 URL 建连
 *
 * 依赖: runtime-config (brokerCandidates/_readBrokerSelection/_setBrokerSelection)
 *       mqtt-relay (MQTTClient) — 测速时临时建一个 probe 连接
 * ===========================================================================*/
(function initBrokerStatusWidget(global){
    'use strict';
    const RC = global.LG_RUNTIME_CONFIG;
    if(!RC || !RC.NET_CONFIG || !Array.isArray(RC.NET_CONFIG.brokerCandidates)) return;

    const candidates = RC.NET_CONFIG.brokerCandidates;
    const getSelection = () => (RC._readBrokerSelection ? RC._readBrokerSelection() : 0);
    const setSelection = (i) => { if(RC._setBrokerSelection) RC._setBrokerSelection(i); };

    // 等待 DOM ready
    function ready(fn){ if(document.readyState!=='loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }

    function el(tag, attrs, ...kids){
        const e = document.createElement(tag);
        if(attrs) for(const k in attrs){
            if(k==='style' && typeof attrs[k]==='object') Object.assign(e.style, attrs[k]);
            else if(k==='class') e.className = attrs[k];
            else if(k.startsWith('on') && typeof attrs[k]==='function') e.addEventListener(k.slice(2), attrs[k]);
            else if(attrs[k]!=null) e.setAttribute(k, attrs[k]);
        }
        for(const kid of kids){
            if(kid==null) continue;
            if(typeof kid==='string') e.appendChild(document.createTextNode(kid));
            else e.appendChild(kid);
        }
        return e;
    }

    // 测速: 临时 MQTTClient, 8s 超时, 看能否拿到 CONNACK
    function probeBroker(cand, timeoutMs){
        return new Promise((resolve)=>{
            const MC = global.LG_MQTT_RELAY && global.LG_MQTT_RELAY.MQTTClient;
            if(!MC){ resolve({ok:false, error:'no MQTTClient'}); return; }
            let done=false;
            const finish=(r)=>{ if(!done){done=true;resolve(r);} };
            const t = setTimeout(()=>finish({ok:false, error:'timeout '+timeoutMs+'ms'}), timeoutMs);
            try{
                const c = new MC({
                    clientId:'probe-'+Math.random().toString(36).slice(2,8),
                    url:cand.url, subprotocol:cand.subprotocol,
                    onOpen:()=>{ /* 拿到 CONNACK 才算真通, 但 onOpen 只代表 ws open */ },
                });
                c._stateListener = (s)=>{ /* 兼容: 我们直接 hook onError + ws.onclose */ };
                // 直接监听 WebSocket open + close
                c.connect();
                // 劫持 onMessage 看 CONNACK: 简单方式 - 2s 内若 state='open' 则认为 OK
                const check = setInterval(()=>{
                    if(c.state==='open'){ clearInterval(check); clearTimeout(t); try{c.destroy();}catch(_e){} finish({ok:true}); }
                    else if(c.state==='failed'){ clearInterval(check); clearTimeout(t); try{c.destroy();}catch(_e){} finish({ok:false, error:c.lastError||'failed'}); }
                }, 250);
                setTimeout(()=>{ clearInterval(check); }, timeoutMs);
            }catch(e){ clearTimeout(t); finish({ok:false, error:e.message||String(e)}); }
        });
    }

    // 自检: 完整 pub/sub 回路测试 (CONNACK + SUBSCRIBE + PUBLISH + 接收回包)
    // 用于区分"broker 握手成功但消息不通"和"broker 完全不可达"
    function selfTestBroker(cand, timeoutMs){
        return new Promise((resolve)=>{
            const MC = global.LG_MQTT_RELAY && global.LG_MQTT_RELAY.MQTTClient;
            if(!MC){ resolve({ok:false, error:'no MQTTClient'}); return; }
            const topic='lg/_selftest/'+Math.random().toString(36).slice(2,10)+'/'+Date.now();
            let done=false;
            const finish=(r)=>{ if(!done){done=true;resolve(r);} };
            const t = setTimeout(()=>{
                if(c) try{c.destroy();}catch(_e){}
                finish({ok:false, error:'timeout '+timeoutMs+'ms'});
            }, timeoutMs);
            let c=null, t0=0;
            try{
                c = new MC({
                    clientId:'selftest-'+Math.random().toString(36).slice(2,8),
                    url:cand.url, subprotocol:cand.subprotocol,
                    onMessage:(m)=>{
                        if(m.topic===topic && m.payload && m.payload.ck){
                            const latency=Date.now()-t0;
                            try{c.destroy();}catch(_e){}
                            finish({ok:true, latency});
                        }
                    }
                });
                c.connect();
                const check = setInterval(()=>{
                    if(c.state==='open'){
                        clearInterval(check);
                        c.subscribe(topic);
                        // 等订阅生效再发(简单的 100ms 缓冲)
                        setTimeout(()=>{
                            t0=Date.now();
                            c.publish(topic, {ck:'selftest', t:t0});
                        }, 150);
                    } else if(c.state==='failed'){
                        clearInterval(check);
                        try{c.destroy();}catch(_e){}
                        finish({ok:false, error:c.lastError||'CONNACK failed'});
                    }
                }, 200);
            }catch(e){ clearTimeout(t); finish({ok:false, error:e.message||String(e)}); }
        });
    }

    function render(){
        const sel = getSelection();
        const cur = candidates[sel] || candidates[0];

        // 读构建版本号 (用于角标显示 + 检测 CDN 旧缓存)
        let buildTag='', assetVer='';
        try{ buildTag=document.querySelector('meta[name="lg-build-tag"]')?.getAttribute('content')||''; }catch(e){}
        try{ assetVer=document.querySelector('meta[name="asset-version"]')?.getAttribute('content')||''; }catch(e){}
        const isStale=buildTag && assetVer && buildTag!==assetVer;

        // 角标
        const dot = el('span', {style:{display:'inline-block',width:'10px',height:'10px',borderRadius:'50%',marginRight:'6px',background:'#aaa',verticalAlign:'middle'}});
        const label = el('span', {style:{fontSize:'12px',color:'#fff'}});
        const verBadge = el('span', {style:{fontSize:'10px',color:'#888',marginLeft:'8px',fontFamily:'monospace'}});
        const card = el('div', {
            id:'broker-status-card',
            style:{
                position:'fixed', right:'12px', bottom:'12px', zIndex:99999,
                background: isStale ? 'rgba(229,115,115,0.95)' : 'rgba(20,20,28,0.85)', color:'#fff',
                padding:'8px 12px', borderRadius:'8px',
                fontFamily:'system-ui,-apple-system,sans-serif',
                boxShadow:'0 2px 10px rgba(0,0,0,0.3)', cursor:'pointer',
                userSelect:'none',
                display:'flex', alignItems:'center', gap:'6px',
            },
            title: isStale ? '⚠️ 浏览器命中 CDN 旧缓存 (页头 v='+assetVer+', 实际应为 v='+buildTag+'). 请 Ctrl+Shift+R 硬刷新!' : '点击查看/切换 MQTT broker',
        }, dot, label, verBadge);
        if(buildTag) verBadge.textContent='v'+assetVer;

        // 面板 (默认隐藏)
        const panel = el('div', {
            id:'broker-status-panel',
            style:{
                position:'fixed', right:'12px', bottom:'60px', zIndex:99999,
                background:'#1c1f26', color:'#e6e6e6',
                padding:'12px', borderRadius:'10px',
                fontFamily:'system-ui,-apple-system,sans-serif', fontSize:'13px',
                boxShadow:'0 4px 20px rgba(0,0,0,0.4)',
                minWidth:'280px', maxWidth:'360px',
                display:'none', flexDirection:'column', gap:'8px',
            }
        });

        const heading = el('div', {style:{fontWeight:'bold', marginBottom:'4px'}}, 'MQTT broker 选择');
        if(buildTag){
            const verLine = el('div', {style:{fontSize:'11px', color: isStale ? '#e57373' : '#888', marginBottom:'4px', fontFamily:'monospace'}},
                isStale ? `⚠️ 浏览器拿到 v${assetVer} (应为 v${buildTag}) — 请硬刷新 Ctrl+Shift+R` : `当前构建 v${buildTag}`);
            panel.appendChild(verLine);
        }
        panel.appendChild(heading);

        const list = el('div', {style:{display:'flex', flexDirection:'column', gap:'4px'}});
        panel.appendChild(list);

        const probeBtn = el('button', {
            style:{
                background:'#3a7bd5', color:'#fff', border:'none',
                padding:'6px 10px', borderRadius:'6px', cursor:'pointer',
                fontSize:'12px', marginTop:'4px',
            },
            onclick:async (ev)=>{
                ev.stopPropagation();
                probeBtn.disabled=true;
                probeBtn.textContent='测速中…';
                for(let i=0;i<candidates.length;i++){
                    const row = list.querySelector(`[data-idx="${i}"]`);
                    const stEl = row && row.querySelector('.status');
                    if(stEl) stEl.textContent='测速中…';
                    const r = await probeBroker(candidates[i], 6000);
                    if(stEl) stEl.textContent = r.ok ? '✓ 可达' : ('✗ '+(r.error||'失败'));
                    if(stEl) stEl.style.color = r.ok ? '#7dd87a' : '#e57373';
                }
                probeBtn.disabled=false;
                probeBtn.textContent='重新测速全部';
            }
        }, '测速全部');
        panel.appendChild(probeBtn);

        // 自检: 验证 pub/sub 真能来回 (不是只 CONNACK 成功)
        const selfTestResult = el('div', {style:{fontSize:'11px', color:'#aaa', marginTop:'4px', minHeight:'14px'}});
        panel.appendChild(selfTestResult);
        const selfTestBtn = el('button', {
            style:{
                background:'#2d8f5f', color:'#fff', border:'none',
                padding:'6px 10px', borderRadius:'6px', cursor:'pointer',
                fontSize:'12px', marginTop:'2px',
            },
            onclick:async (ev)=>{
                ev.stopPropagation();
                selfTestBtn.disabled=true;
                selfTestResult.textContent='自检中…';
                selfTestResult.style.color='#aaa';
                const selNow = getSelection();
                const cand = candidates[selNow] || candidates[0];
                const r = await selfTestBroker(cand, 8000);
                selfTestResult.textContent = r.ok ? `✓ 自检通过 (${r.latency}ms)` : `✗ 自检失败: ${r.error}`;
                selfTestResult.style.color = r.ok ? '#7dd87a' : '#e57373';
                selfTestBtn.disabled=false;
            }
        }, '自检当前 broker');
        panel.appendChild(selfTestBtn);

        const note = el('div', {style:{fontSize:'11px', color:'#888', marginTop:'6px'}},
            '切换 broker 后会自动刷新页面. 测速会临时连接每个 broker (8s 超时).');
        panel.appendChild(note);

        function renderList(){
            list.innerHTML='';
            const selNow = getSelection();
            for(let i=0;i<candidates.length;i++){
                const c = candidates[i];
                const isSel = i===selNow;
                const row = el('label', {
                    'data-idx':String(i),
                    style:{
                        display:'flex', alignItems:'center', gap:'8px',
                        padding:'6px 8px', borderRadius:'6px',
                        background: isSel ? 'rgba(58,123,213,0.25)' : 'transparent',
                        cursor:'pointer',
                    }
                });
                const radio = el('input', {
                    type:'radio', name:'broker-cand', value:String(i),
                    checked: isSel,
                    style:{cursor:'pointer'},
                });
                radio.addEventListener('change', ()=>{
                    setSelection(i);
                    // 立即刷新页面, 让 runtime-config/network-manager 用新 URL
                    try{ location.reload(); }catch(_e){}
                });
                row.appendChild(radio);
                const nameEl = el('span', {style:{flex:'1', fontSize:'12px'}}, c.label || c.url);
                row.appendChild(nameEl);
                const stEl = el('span', {class:'status', style:{fontSize:'11px', color:'#888', minWidth:'60px', textAlign:'right'}}, '');
                row.appendChild(stEl);
                list.appendChild(row);
            }
        }
        renderList();

        // 卡片点击切换面板
        card.addEventListener('click', (ev)=>{
            ev.stopPropagation();
            panel.style.display = (panel.style.display==='none' || !panel.style.display) ? 'flex' : 'none';
        });
        // 点击外部关闭
        document.addEventListener('click', (ev)=>{
            if(!card.contains(ev.target) && !panel.contains(ev.target)) panel.style.display='none';
        });

        document.body.appendChild(card);
        document.body.appendChild(panel);

        // 同步标签: 通过定时探针读 peer.peer._relay.state
        function syncLabel(){
            const selNow = getSelection();
            const c = candidates[selNow] || candidates[0];
            label.textContent = c.label || c.url;
            // 试着读当前 peer 的 relay 状态
            try{
                const net = global.LG_NETWORK_MANAGER && global.LG_NETWORK_MANAGER.__lastCreated;
                const relay = net && net.peer && net.peer._relay;
                if(relay){
                    if(relay.state==='open'){ dot.style.background='#7dd87a'; card.title='已连接到 '+c.url; }
                    else if(relay.state==='connecting'){ dot.style.background='#f7c948'; card.title='连接中… '+c.url; }
                    else if(relay.state==='failed'){ dot.style.background='#e57373'; card.title='连接失败: '+(relay.lastError||'?')+' | 点击切换 broker'; }
                    else { dot.style.background='#888'; card.title='状态: '+relay.state+' | 点击切换 broker'; }
                } else {
                    dot.style.background='#888';
                    card.title='未启用联机 (未建房/未加入)';
                }
            }catch(e){ /* ignore */ }
        }
        syncLabel();
        setInterval(syncLabel, 1500);
    }

    ready(render);
})(window);