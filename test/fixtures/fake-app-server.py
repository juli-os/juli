# ACP 测试用假 app-server：实现 codex app-server 协议的最小子集。
# stdin 收 newline JSON；turn/start → 先回执，再推 turn/started →
# agentMessage item → turn/completed（文本含"失败"时 status=failed）。
import json
import sys

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    if "method" not in msg:
        continue
    method = msg["method"]
    mid = msg.get("id")
    if method == "initialize":
        send({"id": mid, "result": {}})
    elif method == "thread/start":
        send({"id": mid, "result": {"thread": {"id": "th_fake_1"}}})
    elif method == "turn/start":
        send({"id": mid, "result": {}})
        text = msg["params"]["input"][0]["text"]
        send({"method": "turn/started", "params": {"threadId": "th_fake_1", "turn": {"id": "tn_1"}}})
        send({"method": "item/*", "params": {"threadId": "th_fake_1",
              "item": {"type": "agentMessage", "text": "假 agent 的最终汇报"}}})
        status = "failed" if "失败" in text else "completed"
        send({"method": "turn/completed", "params": {"threadId": "th_fake_1", "turn": {"status": status}}})
