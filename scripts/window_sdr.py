from pathlib import Path
import array, math
base=Path('/mnt/tdarr-dev/bench/results/source-port-canary-20260504')
ref=base/'6ch_12s_r128out_fix.cpu.f32'
cand=base/'6ch_12s_r128out_fix.gpu.f32'
ch=6; fpw=19200
a=array.array('f'); a.frombytes(ref.read_bytes())
b=array.array('f'); b.frombytes(cand.read_bytes())
for w in range(len(a)//(fpw*ch)):
    s=d=pk=0.0
    start=w*fpw*ch; end=(w+1)*fpw*ch
    for i in range(start,end):
        x=a[i]; y=b[i]; e=x-y
        s+=x*x; d+=e*e; pk=max(pk,abs(e))
    sdr=10*math.log10(s/d) if s and d else 999
    print(w, f'sdr={sdr:.2f}', f'sim={1-d/s if s else 0:.6f}', f'peakdiff={pk:.4f}')
