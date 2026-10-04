"""Generate a warmer, slower Chinese neural narration. Only public project copy is sent.

Playback uses cached audio. Regeneration needs edge-tts==7.2.8 and network access.
"""
from pathlib import Path
import asyncio,json,ssl,winreg,subprocess,hashlib
import aiohttp,edge_tts,edge_tts.communicate as communicate
S=Path(__file__).resolve().parent
ROOT=next((p for p in S.parents if (p/'miniprogram/app.json').exists()),S.parent)
B=ROOT/'artifacts/product-demo-v7';B.mkdir(parents=True,exist_ok=True)
VOICE='zh-CN-XiaoxiaoNeural'
ctx=ssl.create_default_context();ctx.maximum_version=ssl.TLSVersion.TLSv1_2
communicate._SSL_CTX=ctx  # TLS 1.2 avoids the local proxy's TLS 1.3 negotiation timeout.
try:
 with winreg.OpenKey(winreg.HKEY_CURRENT_USER,r'Software\Microsoft\Windows\CurrentVersion\Internet Settings') as key:
  server=winreg.QueryValueEx(key,'ProxyServer')[0];enabled=winreg.QueryValueEx(key,'ProxyEnable')[0]
 proxy='http://'+server if enabled and server.startswith('127.0.0.1:') else None
except OSError:proxy=None

LINES=[
 {'at':.8,'text':'校园工具。从校园信息，到自己的每一天。'},
 {'at':8,'text':'读资讯，找组织，查课表。从首页，进入你需要的功能。'},
 {'at':19,'text':'把课表文件发到微信，选择文件，就能整理出课程草稿。先校对，再保存。'},
 {'at':40.2,'text':'确认保存，六门课程进入周课表。'},
 {'at':47,'text':'手上只有截图，也没关系。选择图片，识别成草稿，再由你检查和确认。'},
 {'at':64,'text':'按周查看课程，也能手工补上一门临时安排。修改教室后，新的地点会直接显示。'},
 {'at':84,'text':'想安排周三的学习时间，直接问这一天有哪些课。助手会给出课程、节次和地点。'},
 {'at':100,'text':'临时增加项目实践，用日常说法告诉助手。先核对提案，由你确认，课表才会改变。'},
 {'at':114.8,'text':'确认之后，项目实践进入周四第九到十节。'},
 {'at':122,'text':'想了解学生组织，先看职责，也可以继续提问。打开资料入口，回答的依据就能核对。'},
 {'at':144,'text':'从资讯列表读到正文，日期和来源一起保留。需要核实时，原文入口就在文章旁。'},
 {'at':162,'text':'给自己设一个目标日。写下名称，选好日期，剩余天数就能随时查看。'},
 {'at':177,'text':'考试日期，也要看出处。有核准日期就展示，没有可靠信息，就保留官方入口。'},
 {'at':191,'text':'选好性别和年级组，填入各项成绩。参考分和明细，让计算过程更清楚。'},
 {'at':209,'text':'先说清类别、年份和地区，再查官方资料。答案与出处一起呈现，无法核对时，就展示原文。'},
 {'at':228.4,'text':'校园工具。读资讯，找组织，查课表。'}
]
async def main():
 manifest=[]
 previous=json.loads((B/'narration.json').read_text(encoding='utf-8')) if (B/'narration.json').exists() else []
 for i,item in enumerate(LINES):
  audio=B/f'neural-{i:02}.mp3';wav=B/f'voice-{i:02}.wav'
  old=previous[i] if i<len(previous) else {}
  cache_ok=audio.exists() and old.get('text')==item['text'] and old.get('voice')==VOICE and old.get('rate')=='-5%' and old.get('sha256')==hashlib.sha256(audio.read_bytes()).hexdigest()
  if not cache_ok:
   task=edge_tts.Communicate(item['text'],VOICE,rate='-5%',pitch='+0Hz',proxy=proxy,connect_timeout=12,receive_timeout=30)
   pending=audio.with_suffix('.pending.mp3')
   await asyncio.wait_for(task.save(str(pending)),55)
   pending.replace(audio)
  subprocess.run(['ffmpeg','-y','-v','error','-i',str(audio),'-af','highpass=f=75,loudnorm=I=-17:TP=-2:LRA=8','-ar','44100','-ac','1','-c:a','pcm_s16le',str(wav)],check=True)
  probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','json',str(wav)]))
  duration=float(probe['format']['duration'])
  manifest.append({**item,'duration':duration,'voice':VOICE,'rate':'-5%','sha256':hashlib.sha256(audio.read_bytes()).hexdigest()})
  print(f'Neural narration {i+1}/{len(LINES)}: {duration:.2f}s',flush=True)
 (B/'narration.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
 conflicts=[]
 for i,line in enumerate(manifest):
  next_at=manifest[i+1]['at'] if i+1<len(manifest) else 234
  if line['at']+line['duration']>next_at-.3:conflicts.append({'segment':i,'duration':line['duration'],'available':next_at-line['at']-.3})
 (B/'voice-overlaps.json').write_text(json.dumps(conflicts,indent=2),encoding='utf-8')
 print('Timing conflicts:',conflicts,flush=True)
asyncio.run(main())
