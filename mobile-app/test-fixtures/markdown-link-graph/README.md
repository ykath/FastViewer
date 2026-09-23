# Markdown 相对链接测试集

在桌面端用「打开文件」打开本目录下的 `docs/nested/level2.md`，依次点击链接验证应用内跳转。

| 链接 | 期望打开 |
| --- | --- |
| [同级](./peer.md) | `docs/nested/peer.md` |
| [上一级](../level1.md) | `docs/level1.md` |
| [上两级](../../root-peer.md) | `root-peer.md` |
| [根目录索引](../../README.md) | `README.md` |

`docs/level1.md` 与 `root-peer.md` 中也包含反向链接，可继续点回。
