"""v8: reuse the v7 cached neural narration (timeline unchanged) and mix it for the camera-zoom render."""
from pathlib import Path
import numpy as np,json,wave,subprocess,hashlib
S=Path(__file__).resolve().parent
ROOT=next((p for p in S.parents if (p/'miniprogram/app.json').exists()),S.parent)
V=ROOT/'artifacts/product-demo-v7';B=ROOT/'artifacts/product-demo-v8';O=S.parent;SR,DURATION=44100,234
voices=json.loads((V/'narration.json').read_text(encoding='utf-8'))
music=np.zeros((DURATION*SR,2),dtype=np.float64);speech=np.zeros(DURATION*SR,dtype=np.float64)
def add_stereo(start,note,volume,pan):
 start=round(start*SR)
 if start>=len(music):return
 note=note[:len(music)-start];music[start:start+len(note),0]+=note*volume*np.sqrt((1-pan)/2);music[start:start+len(note),1]+=note*volume*np.sqrt((1+pan)/2)

# Slow, soft pentatonic plucks and major-seventh pads; not a sampled commercial song.
beat=60/76
chords=[[48,52,55,59],[41,45,48,52],[45,48,52,55],[43,50,55,57]]
for bar in range(int(DURATION/(beat*4))+1):
 chord=chords[bar%4];at=bar*beat*4
 for j,midi in enumerate(chord):
  length=round(SR*beat*5);t=np.arange(length)/SR;hz=440*2**((midi-69)/12)
  envelope=np.minimum(1,t/.8)*np.exp(-t/(beat*2.2));note=(np.sin(2*np.pi*hz*t)+.06*np.sin(2*np.pi*2*hz*t))*envelope
  add_stereo(at,note,.012,(-.6+j*.4))
for k,at in enumerate(np.arange(0,DURATION,beat*2)):
 midi=[60,64,67,69,67,64,62,64][k%8];t=np.arange(int(SR*2.2))/SR;hz=440*2**((midi-69)/12)
 envelope=(1-np.exp(-t*130))*np.exp(-t*2.7);note=(np.sin(2*np.pi*hz*t)+.16*np.sin(2*np.pi*2*hz*t)*np.exp(-t*6))*envelope
 add_stereo(float(at),note,.032,[-.35,.25,.1,-.2][k%4])

duck=np.ones(len(speech));records=[]
for i,item in enumerate(voices):
 with wave.open(str(V/f'voice-{i:02}.wav')) as f:raw=np.frombuffer(f.readframes(f.getnframes()),dtype='<i2').astype(float)/32768;assert f.getframerate()==SR
 start=round(item['at']*SR);end=start+len(raw)
 assert end<=len(speech),(i,item['at'],len(raw)/SR)
 # Keep the neural voice's natural contour; only a tiny edge fade removes editing clicks.
 fade=min(int(.018*SR),len(raw)//2);raw[:fade]*=np.linspace(0,1,fade);raw[-fade:]*=np.linspace(1,0,fade)
 speech[start:end]+=raw
 lo=max(0,start-int(.45*SR));hi=min(len(duck),end+int(.7*SR));env=np.full(hi-lo,.25)
 pre=start-lo;post=hi-end
 if pre:env[:pre]=np.linspace(1,.25,pre)
 if post:env[-post:]=np.linspace(.25,1,post)
 duck[lo:hi]=np.minimum(duck[lo:hi],env)
 records.append({'at':item['at'],'duration':len(raw)/SR,'text':item['text']})
music*=duck[:,None]
for item in json.loads((S/'showcase-model.json').read_text(encoding='utf-8'))['events']:
 if not item['target']:continue
 at=item['at'];t=np.arange(int(.06*SR))/SR;note=np.sin(2*np.pi*620*t)*np.exp(-t*65);add_stereo(at,note,.019,0)
music*=np.minimum(1,np.arange(len(speech))/(SR*2))[:,None]
music*=np.minimum(1,(len(speech)-np.arange(len(speech)))/(SR*4))[:,None]
mixed=music+speech[:,None]*.82
peak=np.max(np.abs(mixed));gain=min(1,.89/max(peak,1e-6));mixed*=gain
with wave.open(str(B/'soundtrack.wav'),'wb') as f:
 f.setnchannels(2);f.setsampwidth(2);f.setframerate(SR);f.writeframes((mixed*32767).astype('<i2').tobytes())
with wave.open(str(B/'narration-only.wav'),'wb') as f:
 f.setnchannels(1);f.setsampwidth(2);f.setframerate(SR);f.writeframes((np.clip(speech,-.95,.95)*32767).astype('<i2').tobytes())
video=O/'校园工具-镜头推近动画与自然配音-v8.mp4'
subprocess.run(['ffmpeg','-y','-v','error','-i',str(B/'product-silent.mp4'),'-i',str(B/'soundtrack.wav'),'-c:v','copy','-c:a','aac','-b:a','192k','-movflags','+faststart','-shortest',str(video)],check=True)
preview=O/'校园工具-自然配音试听-v8.mp3'
subprocess.run(['ffmpeg','-y','-v','error','-i',str(B/'soundtrack.wav'),'-ss','0.5','-t','15.5','-af','afade=t=out:st=14.8:d=0.7','-c:a','libmp3lame','-b:a','160k',str(preview)],check=True)
def stamp(t):
 ms=round(t*1000);return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}'
srt='\n'.join(f'{i+1}\n{stamp(r["at"])} --> {stamp(r["at"]+r["duration"])}\n{r["text"]}\n' for i,r in enumerate(records))
(O/'校园工具-镜头推近动画与自然配音-v8.srt').write_text(srt,encoding='utf-8')
report={'duration':DURATION,'voice':'zh-CN-XiaoxiaoNeural','rate':'-5%','voiceSegments':len(records),'narration':records,
        'source':'Microsoft Edge online TTS; project copy only; cached for offline playback','music':'Original 76bpm code-generated pads and plucks','voiceDuck':'music reduced to 25% under speech','peak':float(np.max(np.abs(mixed))),
        'video':str(video),'sha256':hashlib.sha256(video.read_bytes()).hexdigest(),'businessAiCalls':'none; app responses remain fixed mock data'}
(B/'audio-video-validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(video);print(preview);print('Voice and mix peak:',report['peak'])
