# DSH 插件开发规范（给外部 AI 的交接说明）

> 你（外部 AI）要在 **DeepSeek Harness（DSH）** 里写一个插件。DSH 不是通用框架，它有一批**必须先知道、否则一定写崩**的约定。请全文读完再动手；有冲突时以本文为准。
>
> ⚠️ **本文档修订于 2026-10-11，原因是当天真的崩了一次 DSH**：一个插件声明了 `dsh.client` 却没有 `exports["./client"]`，导致**必需插件 `modules` 组合失败 → 整个启动中止**（详见 §1 的"血案"）。§1 的模板是**修正后**的版本，照抄即可。

## 0. 你要交付什么

1. 完整的文件清单（每个文件的路径 + 完整内容）
2. 一段「这个插件做什么、怎么用」的说明
3. 一段「我做了哪些自查」（见 §6）
4. **不要**自己安装依赖、**不要**改宿主目录、**不要**运行 git 命令

## 1. 插件的最小结构

```
<插件名>/
  package.json
  lib/
    index.js      ← host 半边（Node 侧，跑在 DSH 主进程里）
    client.js     ← client 半边（浏览器侧，跑在页面里）
```

`package.json` **照抄这个形状**（只改 name/version/description）：

```json
{
  "name": "dsh-my-plugin",
  "version": "0.1.0",
  "description": "一句话说明",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": { "platform": "web" }
  },
  "peerDependencies": {
    "cordis": "*"
  }
}
```

### 🔴 铁律 1（不知道这条就会崩整个 DSH）

**只要声明了 `dsh.client`，`exports` 里就必须有 `"./client"` 指向真实的客户端 bundle 文件。**

- 宿主用 `exports["./client"]` 去解析客户端半边。**缺失 = 解析不到**。
- 后果**不是**"这个插件不加载"，而是：必需插件 `modules` 组合失败 → **整个 DSH 启动中止**。
- 症状：`startup failed: 1 required plugin did not activate`，并伴随一串**看起来像别的插件坏了**的 `failed to import`（那些都是连锁反应，别被带偏）。
- **2026-10-11 血案**：`dsh-wb-outsource` 就是漏了这个 `exports`，一挂上去 DSH 直接起不来，靠另一个 agent 手工补 `exports` 才救回。当时那份清单里 `main` 有、`dsh.client` 有，**只有 `exports` 没有**。
- ⚠️ 反面参照：别只打开同类插件的 `lib/` 就以为抄全了 —— **一定要看它的 `package.json`**，`exports` 就藏在那里。

### 铁律 2：`peerDependencies` 只允许依赖 `cordis`

不要依赖任何 `@deepseek-ai/*`、不要依赖 `axios`/`lodash`/`zod` 之类第三方包 —— 插件目录里**没有**这些包，`import` 会在**加载期**就抛错。

### 铁律 3：绝不 `import '@deepseek-ai/*'`

需要什么就自己用 `ctx` 拿（见 §2），或自己写（例如要造消息就自己拼对象，别去 import 宿主的 `createUserMessage`）。

### 铁律 4：`dsh.client` 里**只写** `platform`

```json
"dsh": { "client": { "platform": "web" } }
```

不要再塞 `inject` / `external` 之类的字段（那是 0.1.x 时代的写法）：多声明字段会让宿主**静默跳过整个 client 半边**（症状：按钮根本不出现，也不报错）。

## 2. host 半边（`lib/index.js`）的形状

```js
export const name = 'dsh-my-plugin';
export const inject = [];              // 需要哪些服务就写名字；用不到就留空数组

export function apply(ctx) {
  // 注册 HTTP 路由（自注册路由不受 DSH 鉴权影响，可当探针）
  ctx.inject(['webServer'], (web) => {
    web.register({
      kind: 'exact',
      path: '/api/dsh-my-plugin/probe',
      handler: (req, res) => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: true }));
      },
    });
  });
}
```

⚠️ **数组式 `inject` 要求"全部服务都可用"才会执行回调**。升级后某个服务被删掉 → 回调**永不执行**（表现为路由 404、功能静默失效）。所以：能单个 `inject` 就单个，并且**不要**把不确定存在的老服务塞进数组。

⚠️ **路由用 `ctx.effect(() => webServer.register(route), 'label')` 注册**，这样卸载时能自动清理。

⚠️ **不要注册名字和宿主已有工具重名的工具**（例如 `subagent`）—— 会直接让新会话创建失败。

⚠️ 服务拿不到时**要降级并打日志**，别直接抛：`const web = ctx.get('webServer'); if (!web || typeof web.register !== 'function') { ctx.logger?.warn?.(...); return; }`

## 3. client 半边（`lib/client.js`）的形状

```js
(function () {
  window.__ModuleLoader__.load({
    id: 'dsh-my-plugin',                 // ⚠️ 必须等于 package.json 的 name
    factory: function (require) {
      var React = require('react');      // client 侧只能用宿主给的模块
      var h = React.createElement;

      function MyButton() {
        return h('button', { type: 'button', title: '说明' }, '🔘');
      }

      function apply(ctx) {
        ctx.inject(['slots'], function (scope) {
          scope.slots.inject('conversation.input.right', function () {
            return scope.slots.register(
              { name: 'conversation.input.right', id: 'dsh-my-plugin', order: 50, label: '我的' },
              MyButton,
            );
          });
        });
      }

      var exports = { name: 'dsh-my-plugin-client', inject: ['slots'], apply: apply };
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
      return exports;
    },
  });
})();
```

⚠️ **client 半边抛任何异常都会连累整个插槽**（别人的按钮一起消失）。所以：

- 样式注入、插槽挂载、网络请求**全都要 try/catch**，失败只 `console.error`；
- **不要引用图标导出**（`primitives.IconXxx16` 这类名字在版本间会改；拿到 `undefined` 当组件用 → React #130 → 整个插槽被丢弃）。要用就先判空兜底。

## 4. 挂载方式

插件本体放在 profile 的 `node_modules/<插件名>/`，然后在 **`cordis.patch.yml`**（**顶层数组**）里追加一条：

```yaml
- insert:
    - id: my-plugin
      name: 'dsh-my-plugin'
```

⚠️ **不要自己改这两个文件**（`cordis.patch.yml` / `package.json`）—— 它们是**宿主的**配置，运行中修改会触发热重载、可能把 DSH 搞崩。**把该加的行写进你的交付说明里，由宿主的人来挂。**

## 5. 这个 DSH 版本（0.2.0 线）已知的坑

| 坑 | 正确做法 |
|---|---|
| `settingsScope` 服务**已被删除** | 客户端设置用 `ctx.remote.settings`（`describe()` / `update(ns, patch, rev)` / `replace()` / `mutate()`；**没有订阅**） |
| `settingsNamespace` / `installSettingsSection` / `ctx.settings.register` 已删 | 配置直接写在 entry config 里 |
| 带 schema 的 codec 改了形状 | 要写成**工厂**：`{ mode:'strict', create: () => ({ parse }) }`，**不是** `{ schema: { parse } }` |
| host 与 client **各有自己的 descriptor 副本** | 改形状要**两份一起改** |
| `systemPrompt.section({name, order, text})` 的 `text` **可以是函数** | 用它做"开关一变、注入段跟着变"（dsh-raw-html 的实证写法）。注意 DSH 会把 system prompt 的变化显示成一条「系统提示词」条目 —— 这是**可见**的 |
| 客户端代码改动要**重启应用**才生效（只按 F5 会拿到旧 bundle，甚至 404） | 交付说明里写明"需要重启" |

## 6. 交付前必须自查（缺一项我会退回来）

- [ ] **声明了 `dsh.client` ⇒ `exports["./client"]` 存在，且它指向的文件真的在磁盘上** ← **第一条，缺了会崩整个 DSH**
- [ ] `exports["."]` 存在且指向真实的 host 入口
- [ ] `dsh.client` 里**只有** `platform`
- [ ] `peerDependencies` **只有 `cordis`**；全文没有 `import '@deepseek-ai/...'`
- [ ] `lib/client.js` 的加载器 `id` **等于** package.json 的 `name`
- [ ] 没有引用任何图标导出（或已判空兜底）
- [ ] 样式注入 / 插槽挂载 / 网络请求都在 try/catch 里
- [ ] 没有用到"已删除的服务/API"（对照 §5）
- [ ] 没有写死机器专属的绝对路径
- [ ] 没有联网请求、没有新增依赖、没有定时器泄漏
- [ ] 给出**回滚方式**（删哪一行挂载、删哪个目录）

## 7. 风格要求

- 注释用**中文**，简短、说人话
- ESM（`export` / `import`），2 空格缩进
- 不要用 TypeScript（宿主直接跑 `.js`）
- 路由用 `/api/<插件名>/<动作>`；命名保持一致
- 单文件尽量 < 400 行；超了就拆
