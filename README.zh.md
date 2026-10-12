# dsh-antigravity-connect

[English](./README.md) | 简体中文

适用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 **Google Antigravity / Cloud Code Assist 模型提供商插件**。

它只做一件事：把你 Google 账号下的 Antigravity 模型接进 DSH，让它们出现在 DSH 的模型选择器里。它**不监听任何对外端口**，也不是一个反向代理服务——设置页用的那点 HTTP 接口挂在 DSH 已有的 Web 服务上。

> 非官方集成。本项目与 Google 无关，也未获 Google 认可。请只在你有权访问的账号和服务上使用。

---

## 它和 `dsh-antigravity` 的区别

两者解决同一个问题，这个版本是照着前者的 OAuth 思路重写的轻量实现：

- **是 DSH 原生插件，而不是一个独立进程。** 配置走 schemastery `Config` + DSH 设置命名空间，可以写在 profile 的 patch 里，也可以在设置页改；凭证和偏好都落在 `$DSH_HOME` 下。
- **契约对齐当前 DSH**（对照已安装的 `@deepseek-ai/dsh-llm` 逐条核过）：`replayState` 用 `ReplayEnvelope { response, blocks }` 结构、思考签名按块对齐回放、`user-agent` 合并成一个值（拆成两个头会被 `fetch` 用逗号拼起来）、`LlmModelReasoningInfo` 不谎报 `defaultEffort`。
- **没有 DOM hack。** 不注入 MutationObserver、不 `setInterval` 轮询、不改别人的导航图标。
- **空闲超时是真的会触发。** 后端沉默时用 race 掐断并释放 socket，而不是挂在那里等。
- **全量离线测试。** 48 个测试，包括把插件挂进真实 Cordis + `LlmRuntime` + `WebServer` 跑通一次完整生成。

---

## 安装

```sh
# 从 GitHub 安装
dsh plugin --profile web add github:<你的用户名>/dsh-antigravity-connect

# 或从本地目录安装
dsh plugin --profile web add /绝对路径/dsh-antigravity-connect
```

装好后重启 DSH：

```sh
dsh web
```

插件声明了 `dsh.bundle.patch`，`dsh plugin add` 会把它登记进 profile 的 `dsh.profile.bundles`，因此在 **设置 > 插件** 的清单里可以看到它。

### 手动安装

如果 `dsh plugin` 用不了，把包放进 profile 再改 `cordis.patch.yml`：

```sh
cp -R dsh-antigravity-connect "$DSH_HOME/profiles/web/node_modules/"
```

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- insert:
    - id: antigravity-connect
      name: dsh-antigravity-connect
```

---

## 登录

打开 **设置 > Antigravity**，点 **登录**。浏览器会走 Google OAuth 授权流程，完成后本页自动刷新。

插件在本机 `127.0.0.1:51121` 起一个回调监听（Google 要求回调地址与注册值完全一致，所以端口固定）。如果浏览器没能自动打开，设置页会给出可手动打开的授权链接。

**无头/远程环境**可以用命令行助手：

```sh
node "$DSH_HOME/profiles/web/node_modules/dsh-antigravity-connect/bin/antigravity-connect-login.mjs"
```

它会打印授权链接、等待回调、写入凭证。加 `--no-open` 不尝试开浏览器，加 `--logout` 清除已有凭证。

凭证位置：

```text
$DSH_HOME/storages/antigravity-connect-oauth.json   （权限 0600）
```

> 这个文件里有 refresh token,请妥善保管。

### 登录失败时

浏览器回调页显示 **`ERR_CONNECTION_REFUSED`**(localhost:51121 拒绝连接),只有两个原因:

1. **授权超时了。** 整个流程只有 5 分钟;设置页会显示倒计时,超时后重新点「登录」即可。
2. **DSH 中途重启过。** 回调监听随进程消失,同样重新点「登录」。

授权 `code` 是**一次性**的,所以失败那次的链接无法复用——必须从设置页重新发起。

如果报的是「端口已被占用」,说明 51121 被别的程序占着,关掉它再试(或在配置里改 `callbackPort`,但那需要同步改 Google 端注册的回调地址,通常不值得)。

---

## 模型

登录后模型会出现在 DSH 模型选择器里。在设置页可以按需勾选，取消勾选的不会出现在选择器中（勾选状态自动保存）。

**列表来自后端,不是写死的。** 插件调用 Cloud Code Assist 的 `fetchAvailableModels` 拉取你账号当前真实可用的模型,所以后端新增或改名模型时**不需要更新插件**——比如 `gemini-3.8-flash` 一上线就会自动出现。每个模型的名称、上下文长度、最大输出、是否支持思考/图片,也全部取自该接口。

选中某个模型时,插件会把它在目录里的**运行时 ID 原样**发给后端,不做二次映射,因此不存在"列表里有、发出去报错"的错配。

额度按池计算:Gemini 模型共享一个池,Claude 与 GPT-OSS 共享另一个。设置页显示各池的实时剩余百分比和重置倒计时,模型列表里也会带上每个模型的实时余量。

推理力度(`off` / `low` / `medium` / `high`)只对目录标记为支持思考的模型出现,不会给不支持的模型一个没用的开关。

> 拉取失败时(未登录、或后端临时故障)会退回到内置的快照列表,保证选择器不会空着;此时设置页会标注 `catalogSource: fallback`,如实说明这不是实时数据。

---

## 配置

首次安装不需要任何配置。要改的话，`cordis.patch.yml` 里加 `config`：

```yaml
- insert:
    - id: antigravity-connect
      name: dsh-antigravity-connect
      config:
        endpoint: https://cloudcode-pa.googleapis.com
        callbackPort: 51121
        streamIdleTimeoutMs: 300000
        systemInstruction: |
          你是一个务实的编程助手，回答保持简洁。
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `endpoint` | `https://cloudcode-pa.googleapis.com` | Cloud Code Assist 基址。主站失败时自动回退到 sandbox 域名（仅限 5xx 和网络错误）。 |
| `callbackPort` | `51121` | OAuth 回环端口，必须与注册的回调地址一致。 |
| `streamIdleTimeoutMs` | `300000` | 单次读取允许的后端沉默上限，超时掐断并释放连接。 |
| `systemInstruction` | Antigravity 基线提示词 | 系统提示词基线，`options.system` 会追加在它后面。 |

偏好文件（勾选的模型）在 `$DSH_HOME/storages/antigravity-connect-preferences.json`。

---

## 开发

插件是纯 ESM,没有构建步骤。但有一个**必须先做对的前提**:

> **插件里的 `@deepseek-ai/*` 是由 App 加载的,不是由你的源码 checkout 或 `~/.dsh/profiles/node_modules` 加载的。** 这几处可能是不同(通常更旧)的版本,对着它们开发会引用到 App 里根本不存在的符号。这种错误在开发时完全看不出来,启动时只报一句 `failed to import`,**不给任何堆栈**——而且整个插件会被静默跳过。

所以本地依赖层要从**已安装的 App 包**同步:

```sh
npm run modules:sync    # 从 app.asar 抽出 @deepseek-ai/*,镜像成 node_modules
npm test                # 48 个测试;pretest 会先校验版本
npm run check           # 语法与模块加载检查
```

`npm test` 前的 `pretest` 会跑 `scripts/check-runtime-versions.mjs`,校验两件事:本地包版本是否与 App 一致,以及本插件用到的每个符号是否都存在。版本漂移时报错长这样:

```
@deepseek-ai/dsh-llm@0.1.1-rc.2  (app ships 0.2.0-rc.2)
  - @deepseek-ai/dsh-llm is missing ToolCallId
```

DeepSeek Harness 装在别处时用 `--asar <路径>`。

客户端半边(`client.js`)是手写的,不由 DSH 打包——DSH 会按原样把它作为 `/plugins/<id>/client.js` 提供给浏览器,所以必须是 `window.__ModuleLoader__.load({ id, factory })` 这个闭包工厂格式,且只能 `require` 平台共享的模块(这里只用了 `react`)。改完保存即可,HMR 会检测到文件变化并热重载。

> 测试里**不要硬编码登录回调端口**。这个 checkout 通常就是 profile 软链指向的插件本体,而测试会真的开一个回环监听;写死端口有实际风险,不是风格问题。用 `freeLoopbackPort()` 让系统分配。

### 模块划分

| 文件 | 职责 |
|---|---|
| `index.js` | 插件入口：配置解析、服务装配、注册 provider 路由 |
| `lib/constants.js` | 端点、scope、OAuth 客户端、超时、wire 头 |
| `lib/oauth.js` | PKCE、回环回调服务、code 换取、惰性刷新 |
| `lib/credentials.js` | 凭证文件读写（0600、原子写、串行化 read-modify-write） |
| `lib/cloudcode.js` | Cloud Code Assist 传输：项目发现、模型目录、额度、SSE 流 |
| `lib/serialize.js` | DSH 消息 ↔ Gemini `contents`/工具 schema 转换 |
| `lib/adapter.js` | `LlmAdapter` 实现：SSE → DSH 流式 chunk |
| `lib/api.js` | 设置页用的 HTTP 路由 |
| `lib/preferences.js` | 模型勾选状态 |
| `lib/catalog.js` | 模型目录、公共 ID → 运行时 ID 路由、输出上限 |

---

## 许可证

[MIT](./LICENSE)
