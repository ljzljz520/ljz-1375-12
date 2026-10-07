# 商号故事卡 · 全栈史料关系库

这是一个面向商号历史资料整理的全栈应用。它不把“商号名”当作唯一事实，而是把**稳定主体、经营时期、历史地点、创立者陈述、招牌、迁址事件、出处、图片授权、商业推广标识与已发布版本**分开建模。

## 运行

```bash
npm start              # 启动服务端和网页，默认 http://localhost:3000
npm test               # 运行 14 项验收/规则测试
npm run build          # 构建 dist/ 静态公开页；首次允许发布种子数据版本
```

无需安装第三方依赖，要求 Node.js >= 20。开发数据保存在被 `.gitignore` 忽略的 `data/store.json`；静态页输出到 `dist/`。

演示身份（开发用，无密码，通过右上角切换）：

- `editor1` / `editor2`：史料编辑；
- `promoter`：只能维护商业推广标识；
- `admin`：兼具编辑、推广与审批发布权限。

## 数据与史学规则

- **商号主体稳定，记录按时期拆分**：同一商号可有多个旧址和多次迁址；`periods` 表示时期，`events` 表示创立、迁址等事件，迁址可自动拆出新的经营时期。
- **同名不等于同一主体**：南院门“永庆和”和东关“永庆和”初始为不同主体；只有证据充分时才能合并。
- **冲突日期并列**：创立日期是带出处的陈述集合。多条来源冲突时并列展示，不用最后编辑值覆盖旧事实。
- **推测与确证可追踪**：推测日期有 `inferred` 和精度；确证时旧陈述标记为 `superseded`，新陈述记录 `supersedesStatementId` 与新出处。
- **地点保留历史语境**：地点保存历史原称、现代展示名、候选位置、依据、置信度和精度（`exact/approximate/street/unresolved` 等）；缺坐标只产生 warning，公开页仍可读。
- **人物和出处版本固定**：创立者陈述固定 `personVersion`，出处引用固定 `sourceVersion`。人物被修订时生成影响清单，审批发布新快照；旧卡仍能读出被引用版本。
- **图片授权独立**：图片撤权后，新发布快照剔除图像数据，只保留撤权说明；旧已发布快照不被篡改。
- **商业推广字段独立授权**：推广标识由 `promotion` 角色维护，普通故事编辑调用会得到 403，不能由正文表单覆盖。

## 合并/撤销合并迁移规则

合并接口保存可逆账本 `merges`：

1. 先在内存中建立合并边并做有向环检测；发现循环立即中止，不迁移任何子记录。
2. 只有双方都为 `active` 时允许合并；被并入方改为 `merged`，并记录 `mergedInto`。
3. 迁移该主体拥有的 `periods`、`events`、`signs`、`statements`，逐条记录集合、ID、原主体与目标主体。
4. 目标主体保留并追加来源主体名称/别名；账本保存目标主体旧别名。
5. 撤销时按账本倒序迁回。若某条记录合并后又被迁移、目标主体又被并入、或账本记录缺失，则拒绝自动撤销，提示按时间倒序处理。
6. 服务端对 JSON 存储的读—改—写加进程内互斥；并发合并只有一个成功，另一个收到状态冲突，不会半迁移。

## 发布、公开页与静态构建

编辑数据和公开数据隔离：

1. 编辑台的变更只进入工作库；人物修订、出处修订、图片撤权、推广修改会生成 `pendingChanges` 影响清单。
2. approver/admin 可逐条批准（执行完整性校验并发布新版本快照）或驳回；存在未处理影响清单时，普通发布会被拒绝，不能绕过。
3. 公开时间轴、地图、搜索、详情和打印都读取同一个 `/api/public/current` 或静态页内注入的同一份快照。
4. 构建采用临时目录 staging + rename；校验失败或注入失败时保留旧 `dist/`。
5. 断引用、缺出处、循环合并、坏日期等为 error；缺坐标为 warning，不阻断阅读和发布。

## 主要接口

- `POST /api/subjects|persons|places|periods|events|signs|sources|media|statements`
- `POST /api/founding-claims`：新增创立日期说；
- `POST /api/statements/:id/confirm-date`：推测日期确证；
- `POST /api/relocations`：迁址事件并拆新时期；
- `POST /api/merges`、`POST /api/merges/:id/unmerge`；
- `POST /api/media/:id/withdraw`：图片撤权；
- `POST /api/promotions`：仅 promotion 权限；
- `GET /api/pendingChanges`、`POST /api/pending/:id/approve`、`POST /api/publications`；
- `GET /api/public/current`、`POST /api/build`。

## 代码结构

- `lib/store.mjs`：JSON 存储、原子落盘、互斥与审计；
- `lib/seed.mjs`：西安商号演示数据，含冲突创立说、同名商号、缺坐标地点；
- `lib/domain.mjs`：陈述、事件、时期、地点、版本、合并、发布校验等领域规则；
- `server.mjs`：HTTP API、角色权限和静态服务；
- `web/`：编辑台、公开时间轴/地图、搜索详情与打印样式；
- `scripts/build.mjs`：快照校验、注入和原子静态构建；
- `test/`：领域规则与 HTTP 权限验收测试。
