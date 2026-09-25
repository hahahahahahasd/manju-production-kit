# 漫剧制作流程工具（本地模板仓库）

从《仙门速成班》的实际制作流程提取的可复用模板。它包含导演镜头卡准入、素材 SHA256 校验、ComfyUI/Wan 视频计划、已审批次串行提交、事件进度、技术收片和视觉审片记录。**不包含**第一集的角色图、配音、视频、模型、工作流 JSON、GPU 凭据或已提交任务记录。克隆此仓库不会启动 GPU。

## 用到新项目

1. 克隆或复制本仓库，作为新项目根目录；需要 Git 历史独立时用 `git clone`。建议 Node.js 20+、`ffmpeg`/`ffprobe`。在 `video/renderers/production-v1/queue-manager` 运行 `npm ci`。
2. 先写段落的 `direction.md` 和 `shots.json`，备齐角色三面图、场景图、首尾关键帧、对白/音效。每条镜头记录起止状态、身份与道具、轴线、主动作和审片结论。参见 [.agents/skills/manju-production/SKILL.md](.agents/skills/manju-production/SKILL.md)。
3. 将 ComfyUI 导出的 API 工作流保存为 `video/renderers/wan-i2v-api.json`，把 `video/renderers/comfyui-wan-i2v.config.example.json` 复制为自己的配置并填入真实节点 ID、输入名、模型和期望媒体规格。服务仅允许通过本机 `localhost` 隧道访问；提交前另核对服务器实际节点/模型清单。
4. 创建符合 `manju.comfyui-wan-i2v-render-plan/v1` 的计划和 `manju.comfyui-event-batch/v1` 的批次。例子见 [docs/example-batch.md](docs/example-batch.md)。批次最多三镜；只有静图/身份/连续性/音频审过的镜头才能进入 `generation_ready`。GPU 关机时只做前两步，不连接或提交。
5. 本地预检：

```sh
node .agents/skills/manju-production/scripts/validate-sequence.mjs --shots production/sequences/SEQ/shots.json
node video/renderers/production-v1/queue-manager/comfy-batch-manager.mjs validate --batch production/batches/batch-001.json
```

6. 只有 GPU 已开机、输入哈希和工作流/模型核对无误，并且本次确实要提交时，才运行：

```sh
node video/renderers/production-v1/queue-manager/comfy-batch-manager.mjs start --batch production/batches/batch-001.json --confirm-gpu
```

提交状态和节点采样进度用 `status`/`health` 查看；连接断开时用 `resume` 查询已有 promptId，**不要重复 start**。`supervisor-config.json` 默认关闭；要自动补队必须先填已审批次、开启 `enabled`，并且显式运行 `supervisor.mjs run --confirm-gpu`。可选 MCP 入口为 `mcp-server.mjs`，使用 stdio，需由所用客户端配置绝对路径。

生成成功只代表技术收片。随后逐镜核对人物、服装、道具几何、动作、景别与口型，再查相邻镜头剧情/空间/声音连续性；不合格素材退回返修，不能直接剪入正片。每次源图、音频、提示词或工作流改变都要重新审核对应镜头。

## 本仓库边界

- 这是可复用的**制作骨架**，不是一键生成完整剧集：剧本、角色资产、首尾帧、ComfyUI API 工作流、正式配音和剪辑仍由各项目提供。
- 原项目的 E01 固定进度账本没有移入；此处 `get_production_progress` 只读通用队列监督状态。整集镜头进度由新项目自行记录。
- `validate` 可离线运行，`start`/`resume`/收片和服务器模型核对要等 GPU 开机；测试只做离线预检，不发起推理。
- 本仓库是本地 Git 仓库，目前没有远程地址，也没有发布或覆盖原项目。

来源和差异见 [docs/extraction.md](docs/extraction.md)。
