# FrameLab · 视频语义标注工作台

本地运行的中文网页工具：上传视频 → 设置抽帧间隔 → 逐帧填写语义标签 → 导出图片与 JSON 数据集。

## 启动

macOS 用户直接双击 **start.command**，会启动服务并打开浏览器。首次需要 Python 3.10+ 和网络以安装依赖；FFmpeg 随依赖提供，无需单独安装。

终端启动：

```bash
cd /Users/snow/Desktop/talktosim/label
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python app.py
```

打开 http://127.0.0.1:5055 。使用期间保持终端运行，按 Ctrl+C 停止。若端口被占用，可使用 `PORT=5056 .venv/bin/python app.py` 并打开对应端口。

## 使用方法

1. 上传视频并填写标注人姓名或 ID。
2. 选择间隔：1 秒表示每秒一帧，0.5 秒表示每秒两帧，也可以自定义 0.04–3600 秒。抽帧保留原始分辨率，输出 JPG。最大上传 20 GB，每项目最多 50,000 帧。
3. 填写每帧的 Class 和五个字段，可为一帧添加多组关系：

| 字段 | 含义 | 示例 |
| --- | --- | --- |
| Class | 类别，可自由填写 | tissue_manipulation |
| X · Instrument | 工具 / 器械 | bipolar forceps |
| Y · Action | 动作 | grasping |
| T · Target | 目标 | tissue |
| Z · Intention | 意图 | stabilize tissue |
| O · Outcome | 结果 | tissue stabilized |

4. 输入后自动保存草稿。Class 是非空标签组的必填字段；五个语义字段齐全后才可标记完成。无相关内容时，移除所有标签并标记完成，即为空标注的负样本。
5. 可以沿用上一帧、筛选未完成帧，用左右箭头切换（输入框内不会触发），Ctrl/⌘ + Enter 完成并下一帧。修改已完成帧会重新变为草稿。
6. 导出全部帧或仅已完成帧，选择 ZIP（图片 + JSON）或仅 JSON。

标注人以每帧为单位记录，修改标签时会更新该帧的标注人和 UTC 时间。当前版本保存每帧最新标注，不保存多人修改历史，不提供账号、协同锁或冲突合并；适合一名使用者在本机标注。

## 导出格式

```text
dataset-xxxxxxxx.zip
├── images/
│   ├── 000001.jpg
│   └── 000002.jpg
├── annotations.json
└── README.txt
```

JSON 使用 COCO 兼容的 `images`、`annotations`、`categories` 表结构，并扩展帧级语义字段。它是帧级分类与语义关系数据，不是目标检测数据，不生成边界框或分割标注。需要严格 COCO 检测数据的训练器应先编写适配器。

```json
{
  "images": [{"id": 1, "file_name": "images/000001.jpg", "width": 1920, "height": 1080, "timestamp_seconds": 0, "reviewed": true, "annotator": "Alice", "updated_at": "..."}],
  "categories": [{"id": 1, "name": "tissue_manipulation", "supercategory": "semantic"}],
  "annotations": [{"id": 1, "image_id": 1, "category_id": 1, "attributes": {"instrument": "bipolar forceps", "action": "grasping", "target": "tissue", "intention": "stabilize tissue", "outcome": "tissue stabilized"}, "annotator": "Alice", "updated_at": "..."}]
}
```

`info` 另记录源视频、抽帧间隔和数据版本；类别从实际标签生成，按名称排序分配 ID。`reviewed=false` 表示草稿；`reviewed=true` 且没有 annotation 表示确认无相关内容。仅 JSON 导出不包含图片，需要使用对应 ZIP 中的 images 文件夹。

时间戳是从 0 开始的规则采样时间网格，FFmpeg 为每个采样位置选择附近的解码帧；采样精度受源视频帧率约束，不是原始帧 PTS。抽帧失败或服务中断时，页面会显示原因，可重新上传创建项目。

## 数据位置与备份

视频、抽出的图片及 `project.json` 持久保存在 `data/<项目 ID>/`。关闭浏览器后仍可从左侧项目列表继续。备份整个 `data/` 文件夹即可保留原视频和标注；ZIP 导出用于分享训练数据，不包含原视频。可以通过 `LABEL_DATA_DIR` 环境变量设置存储目录。

默认只监听本机 127.0.0.1，不需要云端服务。大视频会占用原视频、抽帧图片和临时导出 ZIP 的磁盘空间。上传与抽帧是不同阶段，上传完成后才开始后台解码。首次启动会下载依赖，之后网页不请求外部资源。

## 验证

```bash
.venv/bin/pip install pytest
.venv/bin/python -m pytest -q
```

测试覆盖真实视频生成与抽帧、间隔与时间戳、多标签、空标注、标注人、持久化、JSON/ZIP 内容、非法参数和损坏视频。
