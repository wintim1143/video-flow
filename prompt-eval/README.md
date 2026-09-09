# Prompt 盲测评分包

两组需求，每组两个匿名提示词（A/B）。把每组两个文件一起投给任意 LLM 打分即可，答案在文末揭晓。

## 评分建议（投给评分 LLM 时可直接用）

> 你是 AI 视频提示词评审。下面是同一广告需求的两个提示词，请从以下维度各打 1-10 分并说明理由：
> 1. **需求覆盖度**：需求里的每个要点是否都被落实到 prompt
> 2. **颗粒度**：时间/动作描述的精细程度（是否细化到秒级/亚秒级微动作）
> 3. **一致性控制**：人物/产品/UI 的外观锁定机制是否可靠
> 4. **可生成性**：现有视频生成模型（即梦/豆包/Seedance/MiniMax）按这个 prompt 出片，翻车风险多大（文字渲染、UI 真实感、镜头数是否超能力）
> 5. **可操作性**：普通人拿到后能否直接照做出片
> 最后给每个 prompt 一个总分和胜者。

## 组 1：App 推广（10s / 16:9）
- `app_A.txt` vs `app_B.txt`

## 组 2：商品推广（15s / 9:16）
- `product_A.txt` vs `product_B.txt`

---

## 答案揭晓（评分完再看）

| 文件 | 来源 |
|---|---|
| app_A | goodcase 精选案例：@Just_sharon7 的播放器录屏案例（MiniMax H3）→ https://goodcase.ai/cases/minimax-h3-it-s-just-a-video-player-on-localhost-8080-993d103ff98d |
| app_B | video-flow 系统生成（gpt-5.6-terra，trace tmtsrion5hszu，2 镜） |
| product_A | video-flow 系统生成（gpt-5.6-terra，trace tmtsrlemppfn7，3 镜） |
| product_B | goodcase 精选案例：Lavinia「水光肌」精华液广告（Seedance 2.0，稳定分 90）→ https://goodcase.ai/cases/case-98ee40004d15 |

## 已知差异（先讲明白，避免评分误读）

- **颗粒度**：App 组 A 案例细到 0.2-0.5s 微动作 + 像素级 UI 清单；我们系统的 beats 是 1s 粒度。商品组 B 案例反而是**单段无时间轴**（全靠模型自由发挥），比我们的逐秒节拍粗。
- **生成范式不同**：video-flow 输出是「逐镜独立生成 + 尾帧链拼接」工作流（每镜一段，头部的 #N 前缀是给使用者看的工作说明）；goodcase 案例是「整片单 prompt」一次性生成。评分「可生成性」时请考虑这个差异。
