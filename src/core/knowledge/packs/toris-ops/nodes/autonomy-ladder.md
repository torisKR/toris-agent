---
id: autonomy-ladder
title: Autonomy ladder
tags: autonomy, l3
---

# Autonomy ladder

Default is **L3**. Higher means more you have to undo by hand.

| Level | What happens unattended |
| --- | --- |
| L1 | Plan only. Nothing on disk. |
| L2 | Isolated worktree; applying the diff still asks. |
| L3 | Apply + local commit. Push still asks. Mutating chat tools auto-approve. |
| L4 | Push to a side branch. Default branch untouched. |
| L5 | Fully autonomous, including the default branch. |

`knowledge_write` follows the same gate as `write_file`: below L3 it asks first.
