# CloudBase 模式

本次公开版本的安装与验收以本机使用为主。仓库另含 CloudBase 的服务端实现、容器入口和定时任务示例，适用于已有腾讯云环境的维护者。公网部署需由部署者在自己的账号里完成并验收。

## 组件与配置

- [容器入口](deployment/cloudbase/start.cjs) 要求 `APP_MODE=cloud`，并拒绝本机免登录与本地测试模式。使用实际 HTTPS 服务地址设置 `APP_ORIGIN`。
- 在自己的环境创建文档型数据库集合和私有对象存储，由服务端按用户身份检查访问权限。确认两者都限制访问后再设置 `CLOUD_PRIVATE_RESOURCES_CONFIRMED=1`。此标志记录维护者的确认，资源本身的权限仍需在云端设置。
- 完整占位配置见 [env.example](deployment/cloudbase/env.example)。云资源凭据、站点入口和首次管理员初始化所需的哈希由部署者通过云环境的密钥配置提供。每位登录用户应在自己的「AI 配置」添加模型密钥，部署者请将服务级的模型密钥留空。`node scripts/cloud-secrets.mjs` 可在本机生成初始口令哈希，生成物保存在被 Git 忽略的 `.env.cloud.secrets` 中。
- [定时任务入口](deployment/cloudbase/tick/index.js) 使用部署者自己的 HTTPS 定时接口及随机密钥。网关、云资源和模型调用的费用由部署者管理。

## 部署验收

用不同测试用户分别检查站点入口、管理员初始化、登录、草稿和图片隔离、任务归属及退出登录；访问另一个用户的草稿或图片时应被拒绝。确认静态资源、生成任务、错误提示、存储授权和费用限制后，再分发公开服务地址。仓库的 v0.1.0 本机验证记录不包含任何云端部署结果。

[CloudBase 官方文档](https://docs.cloudbase.net/) · [返回本机使用指南](docs/local-setup.md)
