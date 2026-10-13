/**
 * dsh-wb-outsource — 浏览器半边（classic-script bundle，经 __ModuleLoader__ 注册）
 *
 * 挂在 composer 工具行右侧（`conversation.input.right`，scope=session），就是个 🥚 小药丸：
 *   灰 = 这条会话的外包模式关；亮（橙）= 开。点一下切换，状态由 host 按会话记。
 *
 * ⚠️ 2026-10-13 改为「按会话」：
 *   · 插槽是 scope=session → props 里**带 sessionId**（实测 fiber：props.sessionId
 *     = "session-29c7da52-…"，与宿主 agent.id 同源）。旧的「dock 拿不到 sessionId」
 *     注释是误判（那只说明 renderSlot(key, {}) 的第二个参数是空的，与标准 props 无关）。
 *   · 每次请求都把 sessionId 带上；拿不到就退化成「只读、不可切」，绝不猜。
 *   · 重启后 host 里一条会话都没开 → 按钮自然全灰，不会有任何"假故障"红脸。
 *
 * 设计取向：
 *   · 只读/只切状态，**不触发任何执行**（执行永远由 agent 用 bash 跑 wb.mjs）
 *   · 任何异常都必须被吞掉 —— client 半边抛错会把整个插槽（连同别人的按钮）干掉
 *   · 不依赖任何图标导出（0.2.0 改过图标名，拿到 undefined 当组件用会 #130 炸插槽）
 */

(function () {
  var ROUTE = '/api/dsh-wb-outsource';
  var STYLE_FLAG = 'data-dsh-wb-outsource-style';
  var SESSION_KEY = '__dshWbOutsourceSessionId';
  function rememberSession(id) {
    try {
      if (!id) return;
      if (window[SESSION_KEY] === id) return;
      window[SESSION_KEY] = String(id);
      window.dispatchEvent(new CustomEvent('dsh-wb-outsource-session'));
    } catch (error) { /* 忽略 */ }
  }
  function knownSession() {
    try { return window[SESSION_KEY] || null; } catch (error) { return null; }
  }

  var CSS = [
    '.dsh-wbo-btn{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 9px;border-radius:13px;',
    'border:1px solid var(--dsh-border,rgba(127,127,127,.35));background:transparent;color:inherit;',
    'font-size:12px;cursor:pointer;transition:background .15s,border-color .15s,color .15s;font-family:inherit;',
    'white-space:nowrap;line-height:1}',
    '.dsh-wbo-btn:hover{background:var(--dsh-hover,rgba(127,127,127,.12))}',
    '.dsh-wbo-btn.is-on{border-color:#d9822b;color:#d9822b;background:rgba(217,130,43,.10)}',
    '.dsh-wbo-btn.is-busy{opacity:.6;cursor:progress}',
    '.dsh-wbo-btn.is-warn{border-color:#c0392b;color:#c0392b;background:rgba(192,57,43,.10)}',
    '.dsh-wbo-btn.is-off{opacity:.55;cursor:not-allowed}',
    '.dsh-wbo-egg{font-size:13px;line-height:1}',
    '.dsh-wbo-label{font-size:12px}',
    '.dsh-wbo-dot{font-size:10px;line-height:1;opacity:.9}',
    // 手机上 composer 右侧那一格很窄，只留蛋
    '@media (max-width:640px){.dsh-wbo-label{display:none}.dsh-wbo-btn{padding:0 7px}}',
    '.dsh-wbo-dock{display:inline-flex;align-items:center;gap:4px;font-size:12px;opacity:.85;white-space:nowrap;cursor:default}',
  ].join('');

  function insertStyle() {
    if (document.querySelector('style[' + STYLE_FLAG + ']')) return;
    var el = document.createElement('style');
    el.setAttribute(STYLE_FLAG, '1');
    el.textContent = CSS;
    document.head.appendChild(el);
  }

  /** 安全 GET：任何异常都吞掉，返回 null。 */
  function getState(sid) {
    var url = ROUTE + '/state' + (sid ? '?sessionId=' + encodeURIComponent(String(sid)) : '');
    try {
      return fetch(url)
        .then(function (res) {
          return res.json().catch(function () {
            return null;
          });
        })
        .catch(function () {
          return null;
        });
    } catch (error) {
      return Promise.resolve(null);
    }
  }

  /** 安全 JSON POST：任何异常都吞掉，返回 null。 */
  function post(path, body) {
    try {
      return fetch(ROUTE + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(function (res) {
          return res.json().catch(function () {
            return null;
          });
        })
        .catch(function () {
          return null;
        });
    } catch (error) {
      return Promise.resolve(null);
    }
  }

  window.__ModuleLoader__.load({
    id: 'dsh-wb-outsource',
    factory: function (require) {
      var React = require('react');
      var h = React.createElement;

      function EggButton(props) {
        var stHook = React.useState({ enabled: false, loaded: false, busy: false, warning: null, pending: false, sid: null });
        // 插槽 scope=session → props.sessionId 一定有；兜底用共享的 knownSession()
        var sid = (props && props.sessionId) || knownSession() || null;

        // 一旦拿到就把 sessionId 共享给底部那行（会话切换时也会更新）
        React.useEffect(function () {
          rememberSession(props && props.sessionId);
        }, [props && props.sessionId]);
        var st = stHook[0];
        var setSt = stHook[1];

        // 进页面/换会话拉一次真实状态（host 是权威；换了会话必须重取，不能沿用上一条会话的开关）
        React.useEffect(function () {
          if (!sid) return undefined;
          var alive = true;
          function tick() {
            getState(sid).then(function (data) {
              if (!alive) return;
              if (data && data.ok === true) {
                setSt({ enabled: data.enabled === true, loaded: true, busy: false, warning: data.warning || null, pending: data.pending === true, sid: sid });
              } else {
                setSt({ enabled: false, loaded: true, busy: false, warning: null, pending: false, sid: sid });
              }
            });
          }
          tick();
          // 30 秒轮询：别的窗口/别处改了状态时，这里会自己纠回来（避免显示与实际不一致）
          var t = setInterval(tick, 30000);
          function onSession() { tick(); }
          try { window.addEventListener('dsh-wb-outsource-session', onSession); } catch (error) { /* 忽略 */ }
          return function () {
            alive = false;
            clearInterval(t);
            try { window.removeEventListener('dsh-wb-outsource-session', onSession); } catch (error) { /* 忽略 */ }
          };
        }, [sid]);
        // 组件只服务一条会话；会话一换就清掉旧显示，避免"上一条会话的橙色"串到新会话
        var shown = st.sid === sid ? st : { enabled: false, loaded: false, busy: false, warning: null, pending: false, sid: sid };

        function toggle() {
          if (!sid || shown.busy) return;
          var next = !shown.enabled;
          setSt({ enabled: next, loaded: true, busy: true, warning: null, pending: false, sid: sid }); // 乐观更新，点击要立刻有反馈
          post('/state', { sessionId: sid, enabled: next, by: 'button' }).then(function (data) {
            if (data && data.ok === true) {
              setSt({ enabled: data.enabled === true, loaded: true, busy: false, warning: data.warning || null, pending: data.pending === true, sid: sid });
            } else {
              // 没落定：回滚到 host 的权威状态，不让 UI 撒谎
              getState(sid).then(function (d) {
                setSt({ enabled: d && d.ok === true ? d.enabled === true : !next, loaded: true, busy: false, warning: null, pending: false, sid: sid });
              });
            }
          });
        }

        var tip = !sid
          ? '外包模式：拿不到当前会话 id，暂时不能切（不会瞎猜是哪条会话）。'
          : shown.enabled
            ? '外包模式：本会话【开】—— 这条会话尽量把耗 token 的重活交给本机 WorkBuddy（花积分，不烧 DSH token）。点一下关闭。\n（只对这条会话生效；重启 DSH 后所有会话都会回到「关」）\n（开关状态会写进本条会话的 system prompt，所以对话流里那条「系统提示词」是正常的）'
            : '外包模式：本会话【关】。点一下开启：之后这条会话里，我会尽量把大段编码/写文档/搬砖类重活交给本机 WorkBuddy CLI 去干。\n（不会影响别的会话；重启 DSH 后默认关）';
        if (shown.enabled && shown.pending) {
          tip = '外包模式：本会话【开】（首次生效中）—— 这条会话还没构建过 system prompt，发一条消息后注入就真正生效了。\n\n' + tip;
        }
        if (shown.warning) {
          tip = '⚠️ 开关是开的，但注入未生效（' + shown.warning + '）\n→ 这种情况开关等于没用，请 GET /api/dsh-wb-outsource/probe 看详情，或重启 DSH。\n\n' + tip;
        }

        return h(
          'button',
          {
            type: 'button',
            className: 'dsh-wbo-btn' + (shown.enabled ? ' is-on' : '') + (shown.busy ? ' is-busy' : '') + (shown.warning ? ' is-warn' : '') + (sid ? '' : ' is-off'),
            title: tip,
            disabled: sid ? undefined : true,
            'aria-label': shown.enabled ? '外包模式：本会话开' : '外包模式：本会话关',
            'aria-pressed': shown.enabled ? 'true' : 'false',
            onClick: toggle,
          },
          h('span', { className: 'dsh-wbo-egg', key: 'egg' }, '🥚'),
          h('span', { className: 'dsh-wbo-label', key: 'label' }, '外包'),
          h('span', { className: 'dsh-wbo-dot', key: 'dot', style: { color: shown.enabled ? '#d9822b' : 'inherit' } }, shown.enabled ? '●' : '○'),
        );
      }

      /**
       * 底部状态栏那一行：🥚 本会话外包 N 次 · X 积分
       * 数据来自 host 的 /ledger 路由（host 只读 ~/.dsh/wb-outsource-ledger.json，不 spawn）。
       * 任何异常都必须吞掉 —— client 半边抛错会连累整个插槽。
       */
      function OutsourceDock(props) {
        var stHook = React.useState(null);
        var st = stHook[0];
        var setSt = stHook[1];

        React.useEffect(function () {
          var alive = true;
          function tick() {
            try {
              var sid = (props && props.sessionId) || knownSession();
              fetch(ROUTE + '/ledger' + (sid ? '?sessionId=' + encodeURIComponent(String(sid)) : ''))
                .then(function (r) { return r.json(); })
                .then(function (d) { if (alive && d && d.ok === true) setSt(d); })
                .catch(function () {});
            } catch (error) { /* 失败不影响别的 */ }
          }
          tick();
          var t = setInterval(tick, 30000); // 30 秒刷一次就够（账本只在跑外包时变）
          return function () { alive = false; clearInterval(t); };
        }, []);

        // 只按本会话统计；拿不到会话就不显示这一行
        if (!st || !st.session) return null;
        var lines = (st.runs || []).map(function (r) {
          return '  ' + String(r.label).slice(0, 34) + ' — ' + Number(r.credits || 0).toFixed(2) + ' 积分';
        });
        var title = 'WorkBuddy 外包 · 本会话 ' + st.session.runs + ' 次 · ' + Number(st.session.credits || 0).toFixed(2) + ' 积分'
          + (lines.length > 0 ? '\n' + lines.join('\n') : '')
          + '\n\n🥚 按钮 = 开关本会话的外包模式（只统计本会话，账本是本地汇总，可能略小于服务端账单）';
        return h('span', { className: 'dsh-wbo-dock', title: title },
          h('span', { key: 't' }, '🥚 本会话外包 ' + st.session.runs + ' 次 · ' + Number(st.session.credits || 0).toFixed(2) + ' 积分'));
      }

      function apply(ctx) {
        try {
          insertStyle();
        } catch (error) {
          console.error('[dsh-wb-outsource] 样式注入失败（已忽略）：', error);
        }
        try {
          ctx.inject(['slots'], function (scope) {
            scope.slots.inject('conversation.input.right', function () {
              return scope.slots.register(
                {
                  name: 'conversation.input.right',
                  id: 'dsh-wb-outsource',
                  order: 47,
                  label: '外包模式',
                },
                EggButton,
              );
            });
            // 底部状态栏一行（order 110 → 排在 dsh-balance 的 100 之后）
            scope.slots.inject('conversation.composer.dock', function () {
              return scope.slots.register(
                {
                  name: 'conversation.composer.dock',
                  id: 'dsh-wb-outsource-dock',
                  order: 110,
                },
                OutsourceDock,
              );
            });
          });
        } catch (error) {
          console.error('[dsh-wb-outsource] 插槽挂载失败（已忽略）：', error);
        }
      }

      var exports = { name: 'dsh-wb-outsource-client', inject: ['slots'], apply: apply };
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
      return exports;
    },
  });
})();
