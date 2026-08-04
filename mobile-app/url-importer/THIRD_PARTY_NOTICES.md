# Third-party notices

The LightPage URL importer follows the capture, adapter, media-layout and quality-gate design of
`baoyu-url-to-markdown` 1.61.0 from [JimLiu/baoyu-skills](https://github.com/JimLiu/baoyu-skills),
licensed under the MIT License.

The complete upstream license is included in `LICENSE.baoyu-url-to-markdown`.

Runtime dependencies retain their respective licenses:

- `@mozilla/readability` 0.6.0 (Apache-2.0)
- `chrome-launcher` 1.2.1 (Apache-2.0)
- `ws` 8.18.3 (MIT)

For public pages whose local extraction result does not pass the quality gate, the importer may
send the requested public URL (not the page contents or browser profile) to Defuddle's public
reader endpoint. Defuddle is not linked or bundled into the executable.
