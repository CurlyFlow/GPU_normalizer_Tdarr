from pathlib import Path
import array
import math

base = Path('/mnt/tdarr-dev/bench/results/source-port-canary-20260504')
cpu = base / '6ch_12s_r128out_fix.cpu.gains.f32'
gpu = base / '6ch_12s_gpu_window_gains.f32'
ch = 6
fpw = 19200
cg = array.array('f')
cg.frombytes(cpu.read_bytes())
gg = array.array('f')
gg.frombytes(gpu.read_bytes())

for w in range(min(120, len(gg))):
    start = w * fpw * ch
    end = min(len(cg), (w + 1) * fpw * ch)
    vals = cg[start:end]
    avg = sum(vals) / len(vals)
    mn = min(vals)
    mx = max(vals)
    print(w, f'cpu_avg_db={20*math.log10(max(avg,1e-12)):.3f}', f'cpu_min_db={20*math.log10(max(mn,1e-12)):.3f}', f'cpu_max_db={20*math.log10(max(mx,1e-12)):.3f}', f'gpu_db={20*math.log10(max(gg[w],1e-12)):.3f}')
