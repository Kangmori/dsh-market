# reference/index.json

`tools/convert.js` 的参考字典：GitHub 仓库 → npm 包名 / 版本 / `engines.dsh` / 分类。

- 来源：<https://awesome-dsh-plugin.com/index.json>（公开地址，format 1，当前 3,261 条）
- 用途：反查 npm 身份（约 2.5k 条） + 作为分类推断的训练集
- 刷新：workflow 每天优先拉取上面的地址；只有下载失败或格式异常时才回退这份快照

手动刷新：

```powershell
curl.exe -fsSL https://awesome-dsh-plugin.com/index.json -o reference/index.json
```

这份快照不进入最终产物，只用于转换过程。
