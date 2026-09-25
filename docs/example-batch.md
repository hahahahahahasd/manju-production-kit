# 批次格式

下面仅展示字段。路径相对批次文件，必须替换成新项目实际文件；不能把样例当作审图通过的证明。

```json
{
  "schema": "manju.comfyui-event-batch/v1",
  "id": "episode01-batch001",
  "admission": { "reviewedAt": "<人工审完的 ISO 时间>" },
  "jobs": [{
    "id": "shot001",
    "plan": "../../video/renderers/production-v1/shot001-plan.json",
    "segment": "shot001",
    "productionShot": "../sequences/opening/shots.json",
    "shotId": "shot001",
    "gpuReviewed": true,
    "reviewNotes": "写明身份、关键帧、场景轴线、道具和动作已核查的依据",
    "qualityGate": {
      "nativeDetailReviewed": true,
      "sourceCropUpscaleRatio": 1,
      "maxAllowedUpscaleRatio": 1.25,
      "visibleIdentity": true,
      "identityReferenceReviewed": true
    }
  }]
}
```

计划格式可由 `node video/renderers/comfyui-wan-i2v.mjs init <源计划> --out <计划> --config <配置>` 生成，随后人工补上每段的 `sourceImageSha256`。批次必须只引用状态为 `not_submitted` 的计划段落。`submit` 网络返回不明确时状态为 `unknown`，先查原任务，不得新建计划绕过。
