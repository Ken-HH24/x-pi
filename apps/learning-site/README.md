# x-pi 学习网站

这是 `chapters/*/README.md` 的定制阅读界面。正文仍在章节目录维护，网站负责按能力层组织课程、搜索、版本对比、架构导航，以及相邻 lab 快照的关键代码 Diff。章节体验参考 [Learn Claude Code](https://learn.shareai.run/zh/s01/) 的渐进式组织方式。

```bash
pnpm docs:dev
pnpm docs:build
pnpm docs:preview
```

新增章节时，按 `docs/chapter-template.md` 填写 frontmatter。`diffFiles` 只选择最能体现本章设计变化的文件。

推送到 `main` 后，`.github/workflows/docs.yml` 会构建并部署到 GitHub Pages。仓库首次使用时需要在 GitHub 的 Pages 设置中选择 **GitHub Actions** 作为来源。
