---
title: "Go 性能优化与陷阱 · AI Agent 操作手册"
source: "https://geektutu.com/books/high-performance-go（20 章全量分析）"
additional_sources: "掘金《Golang 高级微调技术》https://juejin.cn/post/7342349357386661914；pprof 实战三篇 https://juejin.cn/post/6844904079525675016 、https://juejin.cn/post/7260429107653247031 、https://juejin.cn/post/7396650216637923339 ；微信《Go 应用性能分析实战》https://mp.weixin.qq.com/s/VevcHD2KvbBAAwxREKtyRA"
derived_from: "极客兔兔《Go 语言高性能编程》 + 掘金《Golang 高级微调技术》 + pprof 实战文章四篇"
audience: "AI coding agents（Claude Code / Codex / Cursor / 自建 Agent）"
go_version_note: "书中实测数据基于 2020 年 go1.13–1.16；规则已标注 Go 1.9 / 1.17 / 1.18 / 1.19 / 1.20 / 1.21 / 1.22 / 1.24 的语义变化"
last_updated: "2026-11-11"
usage: "先读 §0–§1；改代码前查 §8 决策表；提交前跑 §9 检查清单；引用数据前看 §10–§11"
---

# Go 性能优化与陷阱 · AI Agent 操作手册

> **Playbook 入口**：[SKILL.md](../SKILL.md) · **相关模块**：[常用库与代码 Tips](go-libraries-and-tips.md) · [优雅关闭与 K8s](go-graceful-shutdown-k8s.md)

> 本文不是读书笔记，而是把《Go 语言高性能编程》20 章、掘金《Golang 高级微调技术》11 条技巧，以及四篇 pprof 实战文章拆成 **Agent 可直接执行的规则**：每条规则包含触发条件、动作、验证方式。书中数字保留为「证据」，不作为跨机器结论。附加工程技巧见 §12；pprof 的补充内容集中在 §3.2–§3.5。

## 0. Agent 使用协议

### 0.1 读取顺序

| 场景 | 必读 |
|---|---|
| 接到「优化这段 Go 代码」 | §0 → §1 → §8 → 对应主题章节 |
| 排查 CPU / 内存 / 延迟 | §1 → §3 → §8 |
| 内存泄漏、找不到对象持有者 | §3.3 → §3.5（Goref） |
| 编写并发代码 | §5 → §7 |
| Review Go 代码 | §7 → §9.2 |
| 写 benchmark / 性能 PR | §2 → §9.3 |
| 减小二进制 / 启动优化 | §6 |
| 查 defer、interface nil、JSON 配置、import 副作用等工程技巧 | §12 |

### 0.2 规则等级与证据标签

- **MUST**：违反会导致错误、泄漏、数据竞争或不可复现的结论。
- **SHOULD**：默认执行；不执行需有明确理由。
- **CONSIDER**：有收益但有取舍，先测量再决定。
- `[书中实测]`：原书 benchmark 数据，仅用于判断数量级与方向。
- `[运行时事实]`：语言规范 / runtime / 标准库行为。
- `[补充]`：原书未覆盖，但 Agent 落地时必需的内容。

### 0.3 五条铁律

1. **MUST 先证明瓶颈存在，再改代码。** 没有 profile 或 benchmark 的优化视为猜测。
2. **MUST 一次只改一个变量。** 同时改算法、并发度和分配策略，结果不可归因。
3. **MUST 用同一台机器做 A/B。** 跨机器、跨负载、跨 Go 版本的 ns/op 不可直接比较。
4. **MUST 保证语义不变。** 性能改动不得改变可观察行为；并发改动必须过 `-race`。
5. **SHOULD 优先消除分配和算法复杂度，再考虑微优化。** 字符串拼接、切片扩容、反射、锁竞争的收益通常远大于指令级调整。

### 0.4 何时不要优化

- 该路径不在 profile 前 10 且不是 O(n²) / O(n) 级别的明显问题。
- 收益 < 5% 且 benchmark 波动 > 5%（用 `benchstat` 判断）。
- 需要引入 `unsafe`、反射 hack、复制粘贴的第三方池，但没有测试与回滚方案。
- 改动会显著降低可读性，而该代码每年执行次数可忽略。
- 你无法说明「优化前多少、优化后多少、怎么测的」。

---

## 1. 标准性能工作流（MUST 按序执行）

### 1.1 六步闭环

| 步骤 | 动作 | 产物 / 命令 |
|---|---|---|
| 0 确认环境 | Go 版本、GOOS/GOARCH、GOMAXPROCS、是否容器 | `go version`、`go env GOOS GOARCH GOMAXPROCS` |
| 1 建立基线 | 先跑测试与 benchmark，保存原始数据 | `go test ./...`；`go test -run '^$' -bench . -benchmem -count=10 > old.txt` |
| 2 定位瓶颈 | 按症状选 profile，不猜 | `go tool pprof -http=:9999 cpu.out` |
| 3 提出假设 | 写成一句话：「X 导致 Y，改 Z 应使指标下降」 | 记录在 PR / commit |
| 4 单点修改 | 只改一处；保持测试通过 | `gofmt`、`go vet`、`go test -race ./...` |
| 5 统计验证 | 同机、同参数、多次采样，用 benchstat | `benchstat old.txt new.txt` |
| 6 决策 | 有显著收益则保留，否则回滚 | 记录命令、数字、环境 |

### 1.2 常用命令

```bash
# 基线（-run '^$' 跳过普通测试，只跑 benchmark）
go test -run '^$' -bench . -benchmem -count=10 ./... > old.txt

# CPU / 内存 / 阻塞 / 锁 profile
go test -run '^$' -bench 'BenchmarkX' -cpuprofile cpu.out -memprofile mem.out .
go test -run '^$' -bench 'BenchmarkX' -blockprofile block.out -mutexprofile mutex.out .

# 分析
go tool pprof -http=:9999 cpu.out
go tool pprof -top -cum cpu.out
go tool pprof -list 'pkg.Func' cpu.out
go tool pprof -diff_base old.pprof new.pprof

# 统计比较
go install golang.org/x/perf/cmd/benchstat@latest
benchstat old.txt new.txt

# 正确性
go vet ./...
go test -race ./...
```

### 1.3 结论书写模板（Agent 输出时必须包含）

```
瓶颈：<函数/分配点/锁>，证据：<profile 类型 + flat/cum 占比>
改动：<一句话>，影响面：<文件:行>
基线：<ns/op, B/op, allocs/op，count=N>
结果：<ns/op, B/op, allocs/op，count=N，benchstat p 值>
副作用：<无 / 内存换 CPU / 需调用方改 API>
```

---

## 2. Benchmark 基准测试

### 2.1 规则

| ID | 等级 | 规则 |
|---|---|---|
| B1 | MUST | benchmark 放在 `_test.go`，函数名 `BenchmarkXxx(b *testing.B)`，循环体执行 `b.N` 次。 |
| B2 | MUST | 准备数据放在循环外；耗时准备用 `b.ResetTimer()` 排除。 |
| B3 | MUST | 每次迭代都有准备/清理时，用 `b.StopTimer()` / `b.StartTimer()` 包住非被测部分。 |
| B4 | MUST | 防止编译器死码消除：把结果赋给包级变量（sink），或使用 Go 1.24+ 的 `b.Loop()`。 |
| B5 | MUST | 用 `-benchmem` 同时看 `B/op` 与 `allocs/op`；只看 ns/op 会漏掉 GC 压力。 |
| B6 | MUST | 用 `-count=10`（或至少 5）并交给 `benchstat`；单次结果不可信。 |
| B7 | SHOULD | 默认 `-benchtime=1s` 太短时用 `-benchtime=5s` 或 `-benchtime=100x`；总采样时间建议 ≥ 5s。 |
| B8 | SHOULD | 用 `b.Run(name, ...)` 构造不同输入规模，验证 O(1)/O(n)/O(n²)。 |
| B9 | SHOULD | 并发吞吐用 `b.RunParallel` + `-cpu=1,2,4,8`，不要用 `go func` 手工起协程测。 |
| B10 | SHOULD | 测试环境：空闲机器、接电源、关闭节能、避免虚拟机/云主机超分；`GOMAXPROCS` 固定。 |
| B11 | MUST | 不要在 `b.N` 循环里做 `rand.Seed`、读文件、建连接、打日志——这些会淹没被测逻辑。 |
| B12 | MUST | 不要用 `time.Now()` 手工给单次迭代计时；框架已处理计时与次数自适应。 |
| B13 | CONSIDER | `-race` 会带来 5–20 倍开销，不能与性能数字混用；正确性测试与性能测试分开跑。 |

> 原书 `generate` 在每次调用内执行 `rand.Seed(time.Now().UnixNano())`，该调用本身开销很大，是书中 benchmark 的一个噪声源。`[补充]` Agent 应把随机源初始化移出被测函数，或使用 `rand.New(rand.NewSource(seed))`。

### 2.2 标准模板（Go < 1.24）

```go
var sink any // 包级 sink，防止结果被编译器消除

func BenchmarkParse(b *testing.B) {
    data := loadFixture() // 只准备一次
    b.ReportAllocs()
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        sink = parse(data)
    }
}
```

### 2.3 并行吞吐模板

```go
func BenchmarkParseParallel(b *testing.B) {
    data := loadFixture()
    b.ReportAllocs()
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            sink = parse(data)
        }
    })
}
```

### 2.4 子基准模板

```go
func BenchmarkParseSize(b *testing.B) {
    for _, n := range []int{1_000, 10_000, 100_000} {
        b.Run(fmt.Sprintf("n=%d", n), func(b *testing.B) {
            data := makeInput(n)
            b.ReportAllocs()
            b.ResetTimer()
            for i := 0; i < b.N; i++ {
                sink = parse(data)
            }
        })
    }
}
```

### 2.5 Go 1.24+ 写法

```go
func BenchmarkParse(b *testing.B) {
    data := loadFixture()
    for b.Loop() { // 自动排除 setup、保持结果存活、防止优化掉循环体
        sink = parse(data)
    }
}
```

`b.Loop()` 在首次调用时重置计时器，循环结束时停止计时；项目 `go.mod` ≥ 1.24 时优先使用 `[补充]`。

### 2.6 如何读结果

```
BenchmarkGenerateWithCap-8  43  24335658 ns/op  8003641 B/op  1 allocs/op
                            │   │               │            └ 每次操作分配次数
                            │   │               └ 每次操作分配字节数
                            │   └ 每次操作耗时
                            └ GOMAXPROCS=8
```

- 时间与分配都要看：耗时不变但 `B/op` 降一个数量级，仍然能显著降低 GC 压力。
- `-8` 是 `GOMAXPROCS`，不是迭代次数；可用 `-cpu` 改变。
- 迭代次数由框架自适应：1s 内跑完就增大 `b.N`，序列近似 1, 2, 3, 5, 10, 20, 30, 50, 100…

---

## 3. pprof 性能分析

### 3.1 按症状选 profile

| 症状 | profile | 关注指标 | 备注 |
|---|---|---|---|
| CPU 高、吞吐低 | CPU | `flat` / `cum` | 默认每 10ms 采样一次运行中 goroutine 的栈 |
| 内存持续上涨 | heap | `inuse_space` | 当前存活对象 |
| 内存上涨，但 heap 只指向通用分配函数 | heap → Goref | 引用链 / 持有者 | 对象被全局变量、context、池长期持有，见 §3.5 |
| 分配率高、GC 频繁 | heap | `alloc_space` | 累计分配量，定位分配点 |
| 对象数量异常、MARK ASSIST | heap | `inuse_objects` | 对象数/指针密度会放大 GC 标记，见 §3.7 |
| CPU 不高但 P99 高、I/O/锁混合 | fgprof | on-CPU + off-CPU | wall-clock profile，见 §3.7 |
| 延迟被阻塞 | block | 阻塞时长 | 需主动开启采样 |
| 锁竞争 | mutex | 竞争次数/时长 | 需主动开启采样 |
| 协程泄漏 | goroutine | 数量与栈 | `?debug=1` 聚合，`?debug=2` 全栈 |
| 调度 / GC / syscall | trace | 时间线 | `go tool trace`，不是 pprof |

### 3.2 采集方式

**方式 A：benchmark 内建（最常用）**

```bash
go test -run '^$' -bench 'BenchmarkX' -cpuprofile cpu.out -memprofile mem.out .
go tool pprof -http=:9999 cpu.out
```

> 分析已有文件时用 `go tool pprof <binary> <profile>`，同时给出可执行文件，符号与函数名解析更可靠。`[补充]`

**方式 B：程序内 `runtime/pprof`**

```go
f, _ := os.Create("cpu.pprof")
defer f.Close()
pprof.StartCPUProfile(f)
defer pprof.StopCPUProfile()
```

**方式 C：HTTP 服务（仅内网 / 加鉴权）**

```go
import _ "net/http/pprof"

go func() {
    _ = http.ListenAndServe("127.0.0.1:6060", nil)
}()
```

| 端点 | 用途 |
|---|---|
| `/debug/pprof/profile?seconds=30` | CPU |
| `/debug/pprof/heap` | 堆内存 |
| `/debug/pprof/block` | 阻塞 |
| `/debug/pprof/mutex` | 锁 |
| `/debug/pprof/goroutine?debug=2` | 协程栈 |
| `/debug/pprof/trace?seconds=5` | 执行 trace |

**方式 D：程序内按类型采集（`pprof.Lookup`）**

```go
p := pprof.Lookup("heap") // heap / allocs / goroutine / block / mutex / threadcreate
_ = p.WriteTo(w, 0)       // 0=protobuf, 1=聚合文本, 2=完整栈文本
```

**给 profile 打业务标签（CPU / goroutine 专用）**

```go
pprof.Do(ctx, pprof.Labels("tenant", "acme", "route", "/pay"), func(ctx context.Context) {
    handle(ctx)
})
```

采集后进入 pprof 控制台输入 `tags`，即可按标签聚合；适用于多租户、多路由的服务。`[补充]`

### 3.3 规则

| ID | 等级 | 规则 |
|---|---|---|
| P1 | MUST | 先 profile 再改代码；`top` 里没有的函数不要凭直觉优化。 |
| P2 | MUST | CPU profile 需要足够长的负载，建议 ≥ 10s；太短会只采到噪声。 |
| P3 | SHOULD | 一次只开一种 profile；同时采集会互相干扰并放大开销。 |
| P4 | MUST | 内存 profile 是**采样**的，不是精确账本。默认 `runtime.MemProfileRate` 约 512KB 采样一次；设为 1 才逐次记录，但开销极大，只用于短时定位。 |
| P5 | MUST | `block` / `mutex` 默认不采集（0=关闭）；需 `runtime.SetBlockProfileRate(1)` / `runtime.SetMutexProfileFraction(1)`。`1`=全量记录；生产用更大的值降低开销：block 的 rate 是平均阻塞纳秒间隔，mutex 的 fraction 是采样比例。 |
| P6 | SHOULD | 看 `flat` 找自身耗时，看 `cum` 找调用链瓶颈；两者结合。 |
| P7 | SHOULD | 排查内存泄漏用 `inuse_space`；排查 GC 压力用 `alloc_space`。 |
| P8 | SHOULD | A/B 对比用 `go tool pprof -diff_base old.pprof new.pprof`，比两杯咖啡间的肉眼比较可靠。 |
| P9 | MUST | 不要把 `/debug/pprof` 暴露到公网；至少绑定 `127.0.0.1` 或加认证/网关。 |
| P10 | CONSIDER | 线上持续 profiling 采用低采样率 + 短窗口 + 采样上报，不要长期全量开启。 |
| P11 | MUST | 采样语义：CPU 默认 100Hz（Unix 上每 10ms 一次 `SIGPROF`）；heap 默认每分配 512KB 采样一次；block 的 rate 是平均阻塞纳秒间隔；mutex 的 fraction 是采样比例。不要把 block 的数值当成“每 N 次事件”。 |
| P12 | SHOULD | heap 有四个指标：`inuse_space`（存活字节）、`inuse_objects`（存活对象数）、`alloc_space`（累计分配字节）、`alloc_objects`（累计分配对象数）。用 `-sample_index=alloc_objects` 等切换，不要只看默认视图。 |
| P13 | MUST | 查内存泄漏用双快照：`/debug/pprof/heap?gc=1` 取快照 A → 复现/等待 → 再取 B → `go tool pprof -diff_base A B`。单次 heap 容易把缓存或预分配误判为泄漏。 |
| P14 | SHOULD | 多租户/多路由服务用 `pprof.Do(ctx, pprof.Labels(...), fn)` 打标签，控制台用 `tags` 聚合；labels 仅支持 CPU 和 goroutine profile。 |
| P15 | SHOULD | 控制台精确定位：`granularity=lines` 行级聚合、`hide=runtime` 去运行时噪声、`focus=Foo` 收敛调用链、`show=Foo` 只看匹配节点、`tree` 看调用树、`peek` 看邻接节点。 |
| P16 | CONSIDER | heap 只回答“在哪分配”；若怀疑对象被全局 map、长生命周期 context、连接池持有，用 Goref 看引用链（§3.5）。attach 会暂停进程且可能 OOM，优先 `gcore` 离线分析。 |

> 原书称内存 profile「默认每 1000 次分配采样 1 次」；现代 Go 的实际默认是 `MemProfileRate = 512 * 1024` 字节。`[补充]` 以当前 `go doc runtime.MemProfileRate` 为准。

> 常见热点符号：`runtime.mallocgc` → 分配热点（不是 `mallogc`）；`syscall.Read/Write` → 内核态 I/O，考虑缓冲/批量；`bytes.growSlice` → 切片扩容，考虑预分配或复用。先判断是 CPU、分配还是 I/O，再选优化手段。`[补充]`

### 3.4 交互命令速查

在 `(pprof)` 控制台输入：

| 输入 | 作用 |
|---|---|
| `top` / `top -cum` | 按 flat / 累计耗时排序 |
| `top15 -cum` | 只看前 15 个节点 |
| `list Func` | 函数逐行耗时与采样 |
| `weblist Func` | 源码 + 汇编 |
| `peek Func` | 查看调用者/被调用者 |
| `tree` | 调用树 |
| `traces` | 查看所有采样点 |
| `tags` | 按 `pprof.Labels` 聚合 |
| `granularity=lines` | 聚合粒度切到行 |
| `hide=runtime` | 隐藏 runtime 噪声 |
| `focus=Foo` | 只保留经过 Foo 的调用链 |
| `show=Foo` | 只显示匹配 Foo 的节点 |
| `web` | 浏览器打开调用图（需 Graphviz） |

命令行侧还可直接输出：`go tool pprof -pdf/-svg/-text <profile>`。

### 3.5 对象引用分析（Goref）

heap profile 回答“对象在哪分配”，不回答“谁还引用着它”。当 `inuse_space` 持续上涨，但分配点只是通用反序列化/缓冲函数时，用 Goref 从 GC Roots 出发打印引用链。`[补充]`

```bash
go install github.com/cloudwego/goref/cmd/grf@latest

grf attach <PID>                  # 输出 grf.out；会暂停目标进程
go tool pprof -http=:5079 ./grf.out

grf attach <PID> --max-depth=10   # 默认 256；限制引用链深度以加速
grf core <execfile> <corefile>    # 离线分析 coredump
```

输出节点形如：

- 栈变量：`pkg.Func.varName`
- 全局变量：`pkg.globalName`
- 子对象：`Field. (type)`、`$mapkey. (type)`、`$mapval. (type)`、`[0]. (type)`

| 等级 | 规则 |
|---|---|
| MUST | 依赖 DWARF 调试信息；使用 `-ldflags="-s -w"` 会移除 DWARF，Goref 无法解析变量名与类型，基本不可用；需要保留调试信息的构建。参见 §6.3 E12。 |
| MUST | `grf attach` 会暂停目标进程直到命令退出；不要在高峰流量直接执行。 |
| MUST | attach 模式额外占用内存，泄漏场景可能 OOM；优先 `gcore`，把可执行文件 + core 拷到独立机器再 `grf core`。 |
| MUST | 需要 ptrace 权限；容器通常要 `CAP_SYS_PTRACE`、同 PID namespace 或同用户。 |
| SHOULD | 先用 `--max-depth=10` 限制 context 等深链；确认链路后再放大。 |
| CONSIDER | 目标可执行文件支持 go1.19–go1.26；工具本身编译需 Go ≥1.21。版本范围以 README 为准。 |

> 来源：掘金《一个全新的 Go pprof 视角 - 对象引用分析》与 `github.com/cloudwego/goref`（Apache-2.0，仍在维护）。Goref 解决的是“持有者”问题，不替代 heap profile 的“分配点”定位。

### 3.6 火焰图与 flat/cum 判读

火焰图不是时间线：**X 轴是采样占比**（越宽消耗越大），**Y 轴是调用栈深度**。不同渲染器的根方向可能相反（`go tool pprof` Web UI 与 Brendan Gregg 风格），先看界面图例，不要死记“上/下”。

| 形态 | 含义 | 下一步 |
|---|---|---|
| 宽而平的一段 | 该函数自身（flat）占比高 | `list Func` 看具体行 |
| 宽，但主要由子调用撑起 | cum 高 | 继续下钻子调用 |
| 窄而深的链 | 单次调用深，未必是热点 | 结合 flat / cum 判断 |
| 颜色 | 通常无语义或随机 | 不要按颜色判断 |

判读技巧：

- `flat == cum`：子调用没有贡献可归因的采样（可能被内联，或很快返回）。
- `flat == 0`：时间都在子调用，继续往下看。
- `sum%`：按当前排序，当前节点及以上 `flat%` 的累计；用来判断前 N 个节点覆盖了多少。
- 火焰图只提供嫌疑，最终用 `top -cum` + `list Func` + benchmark 确认。

### 3.7 可用性抖动排查：从 P99 到 GC assist

适用场景：QPS 高、P99/可用性抖动，但 **CPU 不高、下游耗时正常、问题无法稳定复现**。这类问题往往不在业务代码，而在 runtime、GC、调度或第三方库。

#### 3.7.1 排查顺序

1. **先算时间预算**：从 trace 看请求总耗时与下游耗时。若 250ms 的请求里 MySQL 只拿到 0.01ms、Redis 只拿到 0.04ms，剩余时间就在 runtime/GC/调度/网络，不要继续只盯下游。
2. **排除流量与资源限制**：QPS 是否有异常、CPU throttling、内存压力、节点问题；不要只看平均值。
3. **CPU profile**：有 CPU 热点按 §3.1–§3.4 处理；没有热点继续。
4. **off-CPU**：用 fgprof（§3.7.2）看 I/O、锁、timer、页交换；再用 block/mutex 补充。
5. **GC**：`GODEBUG=gctrace=1` 看并发标记/扫描与 STW；`go tool trace` 看 GC 周期、调度延迟、MARK ASSIST。
6. **对象数量**：heap 的 `inuse_objects` 看对象数与类型，`inuse_space` 看总内存。对象数多、指针密度高会显著放大 GC 标记成本。
7. **依赖 bug**：若对象集中在某个第三方缓存/池，查该库 issue 与版本；CVE 之外的功能 bug 同样要查。
8. **保留现场**：问题窗口短时，用 Holmes 自动 dump 或 Pyroscope 持续 profiling，避免“抓的时候现场已经没了”。

| 工具 | 回答的问题 | 入口 | 注意 |
|---|---|---|---|
| CPU profile | CPU 花在哪 | `pprof.StartCPUProfile` / `/debug/pprof/profile` | 只看 on-CPU |
| fgprof | on-CPU + off-CPU 各占多少 | `/debug/fgprof?seconds=10` | wall-clock；Go 1.19+ |
| gctrace | GC 周期、并发标记/扫描、STW | `GODEBUG=gctrace=1` | 与环境基线对比 |
| go tool trace | 调度、GC、syscall 时间线 | `go tool trace trace.out` | 文件大，抓短窗口 |
| strace | 系统调用是否阻塞 | `strace -f -p PID` | 有开销，短时使用 |
| heap `inuse_objects` | 谁制造了大量对象 | `-sample_index=inuse_objects` | 与 `inuse_space` 一起看 |
| Holmes / Pyroscope | 事故现场自动保留 | 见 §3.7.4 | 也要防 dump 自身开销 |

#### 3.7.2 fgprof：同时看 on-CPU 与 off-CPU

Go 内置 CPU profiler 只统计 on-CPU 时间；当服务大量等待 I/O、锁、timer 时，CPU 火焰图会很“干净”，但延迟仍然高。fgprof 是 wall-clock profiler，能把 on-CPU 与 off-CPU 放在同一张 pprof 兼容图里。

```go
import (
    "net/http"
    "github.com/felixge/fgprof"
)

func main() {
    http.DefaultServeMux.Handle("/debug/fgprof", fgprof.Handler())
    // 和 net/http/pprof 一起挂在管理端口
}
```

```bash
go tool pprof -http=:6061 'http://127.0.0.1:6060/debug/fgprof?seconds=10'
```

- 适合混合 I/O + CPU 的服务；不是 CPU profiler 的替代，二者互补。
- README 建议 Go 1.19+；更老版本在 goroutine 很多时可能造成明显 STW。
- 采样有开销，生产短时抓取，不要长期全量开启。

#### 3.7.3 gctrace 与 go tool trace：确认 GC assist

```bash
GODEBUG=gctrace=1 ./app
go tool trace trace.out
```

- gctrace 关注并发标记/扫描时间、堆大小、GC 频率；与“正常时段”对比，而不是只看单次绝对值。
- `go tool trace` 里出现 **MARK ASSIST**，表示业务 goroutine 在分配时被迫帮助 GC 标记；它是分配率/对象数压力的症状，不是根因。
- 继续用 heap `inuse_objects` 找“谁制造了对象”，再决定是降分配、限缓存、换库还是调 GC。

一个真实案例（原文）：

- 10w+ QPS 服务可用性偶尔低于 0.999，预约接口高峰期超时。
- 下游 MySQL 只拿到 0.01ms、Redis 0.04ms，时间不在下游。
- gctrace 显示并发标记/扫描时间偏长；go trace 多次出现 MARK ASSIST。
- heap `inuse_objects` 显示约 300 万对象中 100 万+ 来自 gcache 的 LFU 结构。
- 根因是 `bluele/gcache` v0.0.1 的 LFU `Get` 内存泄漏（issue #71，约 100MB、大量指针对象），升级到 v0.0.2 后恢复。

结论：**超时不一定是下游慢，也不一定是 CPU 热；对象数量和 GC assist 同样能吃掉延迟预算。**

#### 3.7.4 自动保留现场：Holmes 与持续 profiling

事故窗口可能只有几分钟（例如缓存 5 分钟后过期），手动抓 pprof 经常来不及。两种做法：

- **Holmes**（`mosn.io/holmes`，Apache-2.0）：按周期采集 goroutine 数、RSS、CPU，超过阈值自动 dump goroutine/CPU/heap profile；支持冷却时间、最大 goroutine 保护。适合“出了事再去看”的自动取证。
- **Pyroscope / 持续 profiling**：持续采样并保留时间窗口，事后按服务、时间、版本回看；接入注意见 `go-libraries-and-tips.md` §2.13。

Holmes 的 dump 本身也可能触发 STW 或额外开销，必须在预发验证阈值、dump 路径和磁盘配额；`Stop()` 要纳入优雅关闭流程。

#### 3.7.5 第三方依赖风险

这次事故的根因是第三方库的功能 bug，不是 CVE。引入依赖时除 `govulncheck` 外，还要：

- 锁定版本，读 changelog，升级前跑集成测试；
- 关注 issue 与 release，尤其是缓存、池、序列化、并发工具类库；
- 对“对象数量/内存缓慢增长”建立监控，不要只等 OOM；
- 保留降级/替换方案，避免把核心路径绑死在单一库上。

---

## 4. 数据结构与内存

### 4.1 字符串拼接

**结论：循环内拼接用 `strings.Builder`，能预估长度就 `Grow`；不要用 `+` 或 `fmt.Sprintf` 做长循环拼接。**

原书数据（n=10000，每段 10B，go1.13-era）`[书中实测]`：

| 方式 | 时间 | 内存 | 分配次数 |
|---|---|---|---|
| `s += str` | 56 ms/op | 530 MB/op | 10026 |
| `fmt.Sprintf` | 112 ms/op | 835 MB/op | 37435 |
| `strings.Builder` | 0.13 ms/op | 0.5 MB/op | 23 |
| `bytes.Buffer` | 0.14 ms/op | 0.4 MB/op | 13 |
| `[]byte` append | 0.12 ms/op | 0.6 MB/op | 24 |
| `[]byte` 预分配 cap | 0.07 ms/op | 0.2 MB/op | 2 |
| `Builder.Grow` | 0.07 ms/op | 0.1 MB/op | 1 |

| ID | 等级 | 规则 |
|---|---|---|
| S1 | MUST | 循环拼接且长度可预估：`var b strings.Builder; b.Grow(n*len(s))`；或 `make([]byte, 0, n)`。 |
| S2 | MUST | 长度不可预估：仍用 `strings.Builder`，让它按倍数扩容，而不是 `+`。 |
| S3 | SHOULD | 需要 `io.Writer` 语义时用 `bytes.Buffer`；纯字符串构建优先 `Builder`（`String()` 不额外拷贝）。 |
| S4 | SHOULD | 固定少量片段（2–5 个）用 `+` 即可，编译器可能直接合并；不要为此引入 Builder。 |
| S5 | MUST | 纯拼接/数字转字符串不要用 `fmt.Sprintf`：用 `strconv.Itoa`、`strconv.AppendInt`、`strings.Join`。 |
| S6 | MUST | `Builder` 不可拷贝；调用 `String()` 后不要再写入同一个 Builder（返回的字符串与底层缓冲区共享内存）。 |
| S7 | CONSIDER | `[]byte` 转 `string` 会拷贝；只有确认只读且生命周期可控时才考虑 `unsafe.String`，并写测试。 |

原理：字符串不可变，`+` 每次都分配「新长度」的新串，n 次拼接累计分配约 `O(n²)`；Builder/Buffer 按几何增长，累计 `O(n)`。原书 1 万次 10B 拼接累计约 500MB，Builder 约 0.52MB，差约 1000 倍。

### 4.2 切片（slice）

**本质：slice 是 `{ptr, len, cap}` 的值类型描述符；切片操作不复制底层数组。**

| ID | 等级 | 规则 |
|---|---|---|
| S8 | MUST | 已知最终元素数量时用 `make([]T, 0, n)` 预分配。原书 100 万元素：1 次分配 / 8MB vs 40 次分配 / 45MB，耗时少约 20%。`[书中实测]` |
| S9 | MUST | `append` 可能扩容并返回新 slice；调用方必须接收返回值，`append(s, x)` 丢弃返回值是 bug。 |
| S10 | MUST | 子切片会保留整个底层数组。只取一小段并长期持有时，用 `copy` 到新 slice，或三索引切片 `s[i:j:j]` 限制 cap。原书 100 个「只留 2 个元素」的子切片保留了 100MB；`copy` 后 3.14MB（强制 GC 后 0.15MB）。`[书中实测]` |
| S11 | SHOULD | 从中间删除/插入是 O(n)；大量随机增删改用链表、map 或树。 |
| S12 | SHOULD | 删除元素后把尾部元素置零（`s[len-1] = zero; s = s[:len-1]`），避免底层数组继续引用对象阻碍 GC。 |
| S13 | SHOULD | 头部弹出 `s = s[1:]` 是 O(1) 但底层数组不释放；高频操作改用环形缓冲区或定期 `copy` 压缩。 |
| S14 | SHOULD | 原 slice 不再使用时，过滤优先原地 `s[:0]` 复用；否则新建 slice 以免覆盖原数据。 |
| S15 | MUST | 函数内 `append` 后长度变化，不会反映到调用方的 slice header；需要影响调用方就返回新 slice（推荐）或传 `*[]T`。 |
| S16 | MUST | 数组是值类型，传参/赋值会整体复制；大数组传 `*[N]T` 或改用 slice。 |
| S17 | CONSIDER | 不要依赖扩容系数做容量规划。Go 1.18+ 的阈值与增长公式已变化（约 256 以下翻倍，之后按 `newcap += (newcap + 3*256) >> 2` 并向上取整到 size class）；以 `make` 显式预分配为准。`[补充]` |

```go
// 只保留尾部 2 个元素并脱离大数组
func last2(origin []int) []int {
    out := make([]int, 2)
    copy(out, origin[len(origin)-2:])
    return out
}

// 或者限制 cap，禁止 append 污染原数组
sub := origin[len(origin)-2 : len(origin) : len(origin)]
```

### 4.3 for 与 range

**结论：`range` 每次迭代把元素复制到循环变量；元素大时用下标遍历。**

原书数据 `[书中实测]`：

| 数据 | for 下标 | range 下标 | range 值 |
|---|---|---|---|
| `[]int`（1M） | 324,512 ns | 322,744 ns | 同量级 |
| `[1024]Item`，Item 含 `[4096]byte` | 324 ns | 330 ns | 467,411 ns |
| `[]*Item` | 4,160 ns | 4,194 ns | 同量级 |

| ID | 等级 | 规则 |
|---|---|---|
| S18 | MUST | 元素大于约 64–128B（经验阈值）且只需读取少数字段时，用 `for i := range s { use(s[i]) }`，不要 `for _, v := range s`。 |
| S19 | MUST | `range` 的 value 是副本，修改 `v` 不会修改原元素；要修改用下标或 `[]*T`。 |
| S20 | CONSIDER | 需要同时读写且元素较大时，把元素改为指针 `[]*T`；代价是分配次数增加、局部性变差，需实测。 |
| S21 | MUST | Go 1.22 起 `for` 循环变量是每轮独立变量，闭包捕获不再全部指向最后一个值；但 `go.mod` 的 `go` 指令低于 1.22 时仍按旧语义编译。Agent 必须检查 `go.mod`。`[补充]` |
| S22 | MUST | `range` 遍历 map 顺序不确定；迭代中删除未访问的键不会被访问，新增键可能被访问也可能不被访问。不要写依赖顺序或「新增必被遍历」的逻辑。 |
| S23 | MUST | nil map 可读、不可写；写 nil map 直接 panic。nil slice 可 range（0 次）、可 append。 |
| S24 | MUST | `range` channel 在 channel 关闭后结束；nil channel 永久阻塞。 |

### 4.4 空结构体 `struct{}`

**结论：`unsafe.Sizeof(struct{}{}) == 0`；用 `map[T]struct{}` 做集合、`chan struct{}` 做信号。**

| ID | 等级 | 规则 |
|---|---|---|
| S25 | SHOULD | Set 用 `map[T]struct{}`，不要 `map[T]bool`；100 万条可省约 1MB 值空间（不含 bucket 开销）。`[书中实测/推算]` |
| S26 | SHOULD | 只传信号的 channel 用 `chan struct{}`；发送 `struct{}{}`，语义明确且零大小。 |
| S27 | CONSIDER | 只有方法、没有字段的类型可用 `type Door struct{}` 作为接收者，避免 `int`/`bool` 的额外字节。 |
| S28 | MUST | `struct{}` 作为结构体最后一个字段时会被填充（防止取地址越界）；需要紧凑布局时不要把它放末尾。 |
| S29 | MUST | 两个不同的零大小变量地址可能相同（规范允许），不能用地址区分它们。 |

### 4.5 内存对齐

**结论：结构体大小 = 字段大小之和 + 对齐填充；字段按对齐值从大到小排列通常最省内存。**

原书数据 `[书中实测]`：

```go
type demo1 struct { a int8; b int16; c int32 } // 8B
type demo2 struct { a int8; c int32; b int16 } // 12B
type demo3 struct { c int32; a struct{} }      // 8B（末尾空结构体被填充）
type demo4 struct { a struct{}; c int32 }      // 4B
```

| ID | 等级 | 规则 |
|---|---|---|
| S30 | SHOULD | 热路径上大量实例化的结构体，按字段对齐值从大到小排列，减少 padding；用 `unsafe.Sizeof` 验证。 |
| S31 | SHOULD | 用 `unsafe.Alignof`、`unsafe.Offsetof` 或 `fieldalignment` 分析器检查，不要靠心算。 |
| S32 | MUST | 结构体对齐值 = 各字段对齐值的最大值；数组对齐值 = 元素对齐值；任意类型至少为 1。 |
| S33 | CONSIDER | 内存对齐保证「不超过字长的访问是原子的」这一前提；但业务代码应使用 `sync/atomic` 的类型化 API，不要手写对齐假设。`[补充]` |
| S34 | MUST | 32 位平台上 64 位原子操作要求 8 字节对齐；把 `int64` 放在结构体首字段或单独分配，否则 `atomic` 可能 panic。`[补充]` |

### 4.6 反射（reflect）

**结论：反射赋值比直接赋值慢 100–1000 倍；热点路径避免反射，必须用时缓存字段下标。**

原书数据 `[书中实测]`：

| 操作 | 耗时 | 相对直接赋值 |
|---|---|---|
| 直接赋值 | 0.302 ns | 1× |
| `Field(i).SetString` | 34.5 ns | ~114× |
| `FieldByName("X")` | 316 ns | ~1046× |
| 缓存 Name→Index 后 `Field` | 78.2 ns | ~259×（比 FieldByName 快 4×） |
| `new(Config)` | 40.9 ns | 1× |
| `reflect.New(typ)` | 62.1 ns | ~1.5× |

| ID | 等级 | 规则 |
|---|---|---|
| S35 | MUST | 热点路径（每请求、每元素、每行）禁止 `FieldByName`；用启动时构建的 `map[string]int` 缓存下标，或直接生成代码。 |
| S36 | SHOULD | 序列化/ORM/参数绑定等反射密集型场景，优先代码生成（easyjson、protobuf、sqlc、stringer）；原书称 easyjson 比标准库 json 快约 5 倍。 |
| S37 | SHOULD | 缓存 `reflect.Type` 与 `reflect.Value` 的可复用部分；不要在循环里反复 `TypeOf` / `ValueOf`。 |
| S38 | MUST | 只有可导出字段可 `Set`；先检查 `CanSet()`，否则 panic。 |
| S39 | CONSIDER | `reflect.New` 只比 `new` 慢约 1.5 倍，真正的成本在字段查找与 `Interface()` 装箱；优化重点应放在后者。 |

---

## 5. 并发编程

### 5.1 Mutex vs RWMutex

**结论：只有读占比高（约 ≥ 80–90%）且临界区不太短时，`RWMutex` 才值得；写多或临界区极短时用 `Mutex`。**

原书数据（每次读写各含 1µs 临界区，1000 次操作）`[书中实测]`：

| 读:写 | Mutex | RWMutex | 结论 |
|---|---|---|---|
| 9:1 | 13.20 ms | 1.75 ms | RWMutex 快约 7.5× |
| 5:5 | 13.15 ms | 6.77 ms | RWMutex 快约 1.9× |
| 1:9 | 13.11 ms | 12.09 ms | 基本相同 |

临界区缩短到 0.1µs 时，9:1 的优势降到约 3–4×；延长到 10µs 时比例与 1µs 接近。`[书中实测]`

| ID | 等级 | 规则 |
|---|---|---|
| C1 | SHOULD | 默认 `sync.Mutex`；仅读多写少且临界区有实际工作量时换 `sync.RWMutex`。 |
| C2 | MUST | 不要在持锁期间做网络/磁盘 I/O、`time.Sleep`、日志输出或调用可能阻塞的回调；把临界区缩到只保护共享状态。 |
| C3 | MUST | 含锁的结构体不可复制；用指针传递，`go vet` 会检查 `copylocks`。 |
| C4 | MUST | 读写共享变量必须使用同一把锁或同一套原子操作；混用 `atomic` 与普通读写仍是数据竞争。 |
| C5 | SHOULD | 小函数用 `defer mu.Unlock()` 防漏；极热路径可手写 Unlock，但必须保证所有返回路径都解锁。 |
| C6 | MUST | 多锁场景固定加锁顺序，避免死锁；所有并发改动跑 `go test -race`。 |
| C7 | CONSIDER | `sync.Mutex` 有正常/饥饿两种模式：等待超过 1ms 进入饥饿模式，锁直接交给队首，抑制尾部延迟；不要假设「新来的请求一定先拿到锁」。`[运行时事实]` |

### 5.2 Goroutine 生命周期与并发数量

**结论：goroutine 不能被外部 kill，必须自己退出；每个 `go` 都要有退出路径。**

原书泄漏实验 `[书中实测]`：1000 次超时调用后残留 1002 个 goroutine；把 `done` 改为缓冲 1，或发送端用 `select { case done <- true: default: }`，残留降为 2。

| 场景 | 错误写法 | 正确写法 |
|---|---|---|
| 超时后发送结果 | `done := make(chan bool)`，接收方已返回 | `make(chan bool, 1)` 或非阻塞发送 |
| 任务协程等待 | `for { select { case t := <-ch: ... } }` | `t, ok := <-ch; if !ok { return }`，并由发送方 `close(ch)` |
| 只通知不传值 | `chan bool` / `chan int` | `chan struct{}` |
| 1 对 1 通知 | `sync.Cond` | channel 更简单 |
| N 个等待者 | 多个 channel 逐个通知 | `sync.Cond.Broadcast` 或 `close(done)` 广播 |

**channel 状态表** `[运行时事实]`：

| 操作 | nil channel | 已关闭 channel | 未关闭 channel |
|---|---|---|---|
| `close` | panic | panic | 成功 |
| 发送 | 永久阻塞 | panic | 阻塞或成功 |
| 接收 | 永久阻塞 | 立即返回零值 | 阻塞或成功 |

| ID | 等级 | 规则 |
|---|---|---|
| C8 | MUST | 每个 goroutine 必须有明确退出条件：channel 关闭、`context.Done()`、超时或有限的循环。 |
| C9 | MUST | 超时场景若子协程之后还要发送结果，channel 必须带缓冲（容量 1）或用 `select + default` 非阻塞发送。 |
| C10 | MUST | 只由发送方关闭 channel；多个发送者时用额外的 `closeCh` 或 `sync.Once`，不要在接收方关闭。 |
| C11 | MUST | 接收方用 `v, ok := <-ch` 判断关闭；`for range ch` 会在关闭后自然退出。 |
| C12 | MUST | 不要设计「杀掉 goroutine」的方案；用 `context.WithCancel/WithTimeout` 传递取消信号，由协程自己检查并返回。 |
| C13 | SHOULD | 创建 `context.WithTimeout` 后必须 `defer cancel()`，否则计时器与子 context 会存活到超时。 |
| C14 | MUST | 禁止无界 `go func()`：用带缓冲 channel 做信号量、`errgroup.SetLimit(n)`、固定 worker pool 或 `ants`/`tunny`。 |
| C15 | MUST | `wg.Add(1)` 必须在 `go` 之前调用；在 goroutine 内 Add 可能与 `Wait` 竞争。 |
| C16 | SHOULD | 每个 goroutine 至少约 2KB 栈；2GB 内存理论上限约 100 万协程，实际因栈增长和业务分配更少。 |
| C17 | SHOULD | 用 `runtime.NumGoroutine()` 做泄漏断言，测试中可配合 `go.uber.org/goleak`；不要只看一次，要看操作前后的差值。 |
| C18 | CONSIDER | 不要用 `time.After` 放在循环里做超时：它无法 Stop，长超时 + 高 QPS 会堆积大量 timer 对象。Go 1.23 起未引用的 timer 可被回收，但显式 `time.NewTimer` + `defer timer.Stop()` 仍是更可控的写法。`[补充]` |

**并发限制模板**：

```go
sem := make(chan struct{}, 8)
var wg sync.WaitGroup
for _, task := range tasks {
    sem <- struct{}{} // 满了就阻塞，天然限流
    wg.Add(1)
    go func(t Task) {
        defer wg.Done()
        defer func() { <-sem }()
        process(t)
    }(task)
}
wg.Wait()
```

```go
g, ctx := errgroup.WithContext(ctx)
g.SetLimit(8)
for _, t := range tasks {
    t := t
    g.Go(func() error { return process(ctx, t) })
}
return g.Wait()
```

### 5.3 sync.Pool

**结论：Pool 用于复用短生命周期临时对象，降低分配次数和 GC 压力；不能当缓存，不能依赖其中一定有值。**

原书数据 `[书中实测]`：

| 场景 | 普通 | 使用 Pool |
|---|---|---|
| json 反序列化 | 559,768 ns/op，5096 B/op，7 allocs | 550,223 ns/op，234 B/op，6 allocs |
| bytes.Buffer 写入 | 1299 ns/op，10240 B/op，1 alloc | 133 ns/op，0 B/op，0 alloc |

| ID | 等级 | 规则 |
|---|---|---|
| C19 | SHOULD | 典型对象：`bytes.Buffer`、临时 struct、序列化缓冲、`fmt` 的 printer 状态。 |
| C20 | MUST | `Get()` 返回的对象状态未知；使用前必须 Reset/清零，不能假设是零值。 |
| C21 | MUST | `Put()` 前清理大字段/切片引用，避免池对象长期持有大内存（标准库 `fmt` 对 `cap > 64KB` 的 buffer 直接丢弃）。 |
| C22 | MUST | Pool 可能在任意 GC 时被清空；不能把 Pool 当有保证的缓存，也不能依赖对象一定被复用。 |
| C23 | MUST | 不要把连接、文件句柄、带 finalizer 的对象放进 Pool；它们的生命周期语义不同。 |
| C24 | MUST | `Put` 后不得再使用该对象；重复 `Put` 同一对象会导致并发复用与数据竞争。 |
| C25 | SHOULD | 在 benchmark 中用 `-benchmem` 验证 Pool 是否真的降低了 `B/op` 与 `allocs/op`；小对象 + 重计算场景可能只省内存不省时间。 |

```go
var bufPool = sync.Pool{
    New: func() any { return new(bytes.Buffer) },
}

func encode(v any) []byte {
    buf := bufPool.Get().(*bytes.Buffer)
    buf.Reset() // 必须
    defer func() {
        if buf.Cap() <= 64<<10 { // 防止池持有超大缓冲
            bufPool.Put(buf)
        }
    }()
    _ = json.NewEncoder(buf).Encode(v)
    return append([]byte(nil), buf.Bytes()...) // 返回值不能与池对象共享
}
```

### 5.4 sync.Once

**结论：`Once.Do` 保证并发下只执行一次；适合懒初始化，不适合每请求初始化。**

| ID | 等级 | 规则 |
|---|---|---|
| C26 | SHOULD | 配置、连接、字典等「进程内只初始化一次」的场景用 `sync.Once`，优于 `init` 的 eager 初始化。 |
| C27 | MUST | `Do(f)` 中 `f` 若 panic，`sync.Once` 仍会标记为已完成，后续调用不会重试；需要重试就不要用 Once。`[运行时事实]` |
| C28 | CONSIDER | Go 1.21+ 可用 `sync.OnceValue` / `sync.OnceValues` 缓存返回值，代码更短；其 panic 语义与 `Once` 不同（会缓存 panic 并在后续调用重现）。`[补充]` |
| C29 | SHOULD | 单例对象在 `Do` 内完整构造后再发布；不要在 `Do` 外先赋部分字段，否则其他 goroutine 可能看到半初始化状态。 |

```go
var (
    once   sync.Once
    config *Config
)

func Config() *Config {
    once.Do(func() {
        config = loadConfig() // 完整构造后一次性发布
    })
    return config
}
```

### 5.5 sync.Cond

**结论：`Cond` 适合「一个/多个写者改变条件，多个等待者被唤醒」；1 对 1 通知优先 channel。**

| ID | 等级 | 规则 |
|---|---|---|
| C30 | MUST | `Wait()` 必须放在 `for !condition() { c.Wait() }` 循环中，不能用 `if`；被唤醒不代表条件成立。 |
| C31 | MUST | 修改条件时必须持有 `c.L`；`Wait` 会自动释放并在返回前重新加锁。 |
| C32 | SHOULD | 唤醒所有等待者用 `Broadcast`，只唤醒一个用 `Signal`；调用时可持锁也可不持锁。 |
| C33 | CONSIDER | 如果等待者只是等「关闭/开始」信号，`close(done)` 广播比 Cond 更简单且无锁。 |

---

## 6. 编译与运行时

### 6.1 逃逸分析

**结论：栈分配只需 PUSH/POP，堆分配要 GC；逃逸分析在编译期决定分配位置。**

| ID | 等级 | 规则 |
|---|---|---|
| E1 | MUST | 怀疑分配问题时先看逃逸：`go build -gcflags=-m ./...`；需要原因时用 `-gcflags=-m=2`。 |
| E2 | MUST | 常见逃逸触发：返回局部变量指针、传给 `interface{}` 参数、闭包捕获、超过阈值的大对象、编译期未知大小的 `make`、放入全局/发送到 channel。 |
| E3 | SHOULD | 小且只读的结构体传值，避免指针逃逸与 GC；大结构体或需要修改时传指针。原书建议：修改原对象或大对象用指针，只读小对象用值。 |
| E4 | SHOULD | 减少 `interface{}` / `any` 装箱：泛型（Go 1.18+）或具体类型函数可避免逃逸与类型断言。`[补充]` |
| E5 | MUST | 阈值是版本相关的经验值：原书实验在 64 位平台以 64KB 为界，`make([]int, 8191)` 不逃逸、`8192` 逃逸；不要把它当规范。`[书中实测]` |
| E6 | CONSIDER | 内联能促进栈分配；`-gcflags=-m` 看到 `can inline` 说明函数可内联。不要为了内联强行拆函数，先看 profile。 |

```bash
go build -gcflags='-m' ./... 2>&1 | grep -E 'escapes to heap|moved to heap|can inline'
```

### 6.2 死码消除（DCE）

**结论：编译期能确定的常量分支会被删除；包级 `var` 通常无法推断，局部 `var` 可以。**

原书数据 `[书中实测]`：全局 `const a, b = 10, 20` 编译后 1,895,424B；全局 `var a, b = 10, 20` 为 2,120,368B，大约多 11%。

| ID | 等级 | 规则 |
|---|---|---|
| E7 | SHOULD | 能确定为常量的全局值用 `const`，不要用 `var`；分支和计算会在编译期折叠。 |
| E8 | SHOULD | 调试代码用 `const debug = false` + `if debug { ... }`，release 编译时整段消失，无运行时开销。 |
| E9 | SHOULD | 需要不改源码切换 debug/release 时用 build tags；现代写法是 `//go:build debug`，不要再写旧的 `// +build`。`[补充]` |
| E10 | MUST | 不要依赖 DCE 隐藏敏感信息（密钥、后门 URL）；只要被活代码引用就会留在二进制里。 |
| E11 | CONSIDER | 局部变量能被 DCE 是因为修改只发生在函数内；一旦有 goroutine 并发修改或包级导出变量，推断失效，不要期待优化。 |

```go
//go:build debug

package main

const debug = true
```

```go
//go:build !debug

package main

const debug = false
```

构建：`go build -tags debug -o app-debug .`

### 6.3 减小二进制体积

原书数据（RPC server，go1.13-era）`[书中实测]`：

| 方式 | 体积 | 降幅 |
|---|---|---|
| 默认 | 9.8 MB | — |
| `-ldflags="-s -w"` | 7.8 MB | ~20% |
| `upx -9` | 5.0 MB | ~50% |
| `-s -w` + `upx -9` | 3.0 MB | ~70% |

| ID | 等级 | 规则 |
|---|---|---|
| E12 | SHOULD | release 构建加 `-ldflags="-s -w"`：`-s` 去符号表/调试信息，`-w` 去 DWARF；代价是无法用 gdb/delve 做源码级调试，panic 栈通常仍可用；同时会让 Goref/Delve 无法解析 DWARF 类型，需要引用分析时保留调试信息。 |
| E13 | SHOULD | 加 `-trimpath` 去掉构建机绝对路径，提升可复现性与隐私。`[补充]` |
| E14 | CONSIDER | UPX 是带壳压缩，启动时内存解压；收益是分发体积，代价是启动开销、杀毒误报、部分环境不允许。服务端常驻进程通常不需要。 |
| E15 | SHOULD | 优先排查体积来源：大依赖、`embed` 的静态资源、重复的 protobuf/JSON 代码；压缩是最后手段。 |
| E16 | CONSIDER | 用 `go tool nm -size` / `go tool buildid` / `go version -m` 检查符号与模块信息，不要盲压。`[补充]` |

### 6.4 GC 与运行时旋钮（补充）

| ID | 等级 | 规则 |
|---|---|---|
| E17 | CONSIDER | 调 GC 前先降低分配率；`GOGC` 提高会增大堆、降低 GC 频率，`GOMEMLIMIT`（Go 1.19+）给软上限，二者要配合而非替代。 |
| E18 | SHOULD | 用 `GODEBUG=gctrace=1` 观察 GC 周期、堆大小与 STW；不要凭感觉设置 `GOGC=off`。 |
| E19 | SHOULD | 容器内确认 `GOMAXPROCS` 与 CPU limit 匹配；老版本 Go 可能按宿主机核数设置，导致过度并行。`[补充]` |
| E20 | MUST | 任何 `GOGC` / `GOMEMLIMIT` / `GOMAXPROCS` 调整都要带压测数据与回滚方案，不能写死在库代码里。 |

---

## 7. 语言陷阱速查

| # | 陷阱 | 现象 | 修复 |
|---|---|---|---|
| 1 | 数组按值传递 | 函数内修改数组，调用方看不到 | 传 `*[N]T` 或改用 slice |
| 2 | slice 传参只复制 header | 函数内 `append` 扩容后，调用方仍是旧 slice | 返回新 slice，或传 `*[]T` |
| 3 | 子切片保留大数组 | 只留 2 个元素，却让 1MB 底层数组无法回收 | `copy` 到新 slice，或 `s[i:j:j]` |
| 4 | range 值是副本 | 修改 `v` 无效；大结构体复制昂贵 | 用下标或 `[]*T` |
| 5 | nil map 写入 | `panic: assignment to entry in nil map` | `make(map[K]V)` 后再写 |
| 6 | 重复关闭 channel | `panic: close of closed channel` | 只让唯一发送方关闭；或 `sync.Once` |
| 7 | 向已关闭 channel 发送 | panic | 发送前确认所有权/生命周期 |
| 8 | 超时后无缓冲发送 | 子协程永久阻塞，goroutine 泄漏 | 缓冲 1 或 `select + default` |
| 9 | 忘记 `cancel()` | context/计时器存活到超时 | `defer cancel()` |
| 10 | 循环变量捕获（Go < 1.22） | 所有闭包看到最后一个值 | 循环内 `v := v`；Go 1.22+ 已修复 |
| 11 | `defer` 写在循环里 | 文件/锁/连接直到函数返回才释放 | 抽成小函数，或显式关闭 |
| 12 | 循环内 `time.After` | 计时器堆积，内存上涨 | `time.NewTimer` + `Stop` |
| 13 | 复制含锁结构体 | `go vet: copylocks`，锁状态被复制 | 用指针，`noCopy` |
| 14 | typed nil interface | `var p *T=nil; var i any=p; i != nil` 为 true | 判空用具体类型，或返回未装箱的 nil |
| 15 | `string`/`[]byte` 互转 | 每次转换都拷贝 | 热路径用 `bytes.Buffer`/`Builder`，或谨慎 `unsafe` |
| 16 | map 并发写 | `fatal error: concurrent map writes` | 加锁、`sync.Map`（读多写少）或分片 |
| 17 | WaitGroup 复用/Add 时机 | `Wait` 提前返回或 panic | `Add` 在 `go` 前；每轮重新初始化 |
| 18 | 共享 slice 并发 append | 数据竞争、元素丢失 | 每 goroutine 独立 slice，最后合并 |

> 第 1–4、6–7 条在原书「语言陷阱」「切片」「如何退出协程」中有完整示例；其余为 Agent 落地时高频补充。`[补充]`

---

## 8. 症状 → 动作决策表

| 症状 / 目标 | 第一步 | 常见根因 | 首选修复 |
|---|---|---|---|
| CPU 打满 | CPU profile `top -cum` | 热循环、JSON/反射、正则、重复计算 | 算法/缓存/代码生成/减少反射 |
| 分配率高、GC 频繁 | `-benchmem` + heap `alloc_space` | 字符串 `+`、切片扩容、`any` 装箱、闭包 | Builder/Grow、预分配、泛型、Pool |
| 内存只涨不降 | heap `inuse_space` + goroutine | 子切片保留、goroutine 泄漏、无界 map/缓存、timer | copy、修退出路径、加容量上限、Stop timer |
| 内存涨但 heap 只指向通用分配函数 | heap `inuse_space` + 引用搜索 | 对象被全局 map、长生命周期 context、连接池持有 | Goref 看引用链（§3.5）；先 `gcore` 离线分析 |
| P99 延迟尖刺 | `go tool trace` + mutex/block | 锁竞争、STW、syscall、调度饥饿 | 缩短临界区、分片锁、Pool、限流 |
| P99 高但 CPU 不高 | fgprof + gctrace + trace | off-CPU、GC assist、调度延迟 | 降分配/对象数、修 I/O/锁、扩容 |
| gctrace 并发标记长、trace 出现 MARK ASSIST | heap `inuse_objects` + alloc profile | 对象数多、指针密度高、分配率大 | 减少对象、Pool、限制缓存、修第三方库 |
| 对象数异常增长、内存缓慢上涨 | heap `inuse_objects` + 依赖 issue | 第三方缓存/池/全局 map | 升级/替换库、加容量上限、Goref 看持有者 |
| 事故窗口短、手动抓不到现场 | Holmes / Pyroscope | 问题几分钟内消失 | 自动 dump / 持续 profiling |
| 读多写少但吞吐低 | mutex profile | 用 Mutex 保护读 | 读多写少改 `RWMutex` 或原子/副本 |
| 写多却用了 RWMutex | mutex profile | RWMutex 额外开销 | 改回 `Mutex` |
| goroutine 数量暴涨 | `NumGoroutine` / goroutine profile | 无界 `go`、超时泄漏、channel 阻塞 | 信号量/worker pool、缓冲 channel、context |
| 启动慢 | 启动阶段 CPU profile | `init` 重活、大配置、反射扫描 | 懒初始化（Once）、延迟加载 |
| 二进制大 | `ls -lh` + `go tool nm` | 调试信息、重依赖、embed 资源 | `-s -w`、`-trimpath`、裁剪依赖、UPX |
| 单次操作看似很快但吞吐低 | 并行 benchmark `-cpu` | 锁/共享状态/伪共享 | 分片、减少共享、批处理 |
| 反射赋值慢 | CPU profile `FieldByName` | 按名查找 O(N) | 缓存 Name→Index 或代码生成 |
| 大量小对象 | heap `alloc_space` | 每请求新建 struct/buffer | `sync.Pool`，但先确认复用安全 |

---

## 9. Agent 检查清单

### 9.1 优化前

- [ ] 已确认 `go.mod` 的 Go 版本与目标平台。
- [ ] 已跑通现有测试，记录基线 benchmark（`-count=10`）。
- [ ] 已用 profile 证明瓶颈位置与占比。
- [ ] 已写出「假设 → 预期指标变化」。
- [ ] 已确认该路径的调用频率；冷路径不做微优化。
- [ ] 已确认没有更简单的算法/批处理/缓存方案。

### 9.2 改代码时

- [ ] 一次只改一个变量；diff 可独立回滚。
- [ ] 不改变公开 API、错误语义、日志语义。
- [ ] 并发改动：每个 goroutine 有退出路径，channel 有明确关闭方。
- [ ] 锁：不持锁做 I/O；不复制含锁结构体；多锁顺序一致。
- [ ] 内存：预分配、清理引用、Pool 对象 Reset 后再用。
- [ ] 没有为了微优化引入 `unsafe`（除非有测试、注释与回滚）。
- [ ] 新增常量/配置有默认值，不改变旧行为。

### 9.3 提交前

- [ ] `gofmt -w` / `go vet ./...` 通过。
- [ ] `go test ./...` 与 `go test -race ./...` 通过。
- [ ] 同机 A/B benchmark 完成，`benchstat` 显示显著差异（p < 0.05 且幅度 > 5%）。
- [ ] 记录优化前后 `ns/op`、`B/op`、`allocs/op`、Go 版本、机器信息。
- [ ] 若无显著收益，已回滚，而不是保留「看起来更快」的复杂代码。
- [ ] PR 描述包含：瓶颈证据、改动理由、验证命令、风险与回滚方式。

### 9.4 Benchmark PR 专项

- [ ] setup 在计时器外，或使用 `ResetTimer` / `StopTimer`。
- [ ] 结果写入 sink，防止 DCE。
- [ ] 覆盖真实输入规模（子基准），不只测空输入。
- [ ] 包含并行场景（如适用）与 `-cpu` 变化。
- [ ] 不把 `-race` 的数字当性能数据。
- [ ] 不在 benchmark 内打日志、读网络、`rand.Seed`。

### 9.5 线上抖动排查

- [ ] 已计算请求时间预算，确认下游耗时占比，而不是只盯下游。
- [ ] CPU profile 无热点时，已用 fgprof / block / mutex 看 off-CPU。
- [ ] 已抓 `gctrace` 与 `go tool trace`，确认 MARK ASSIST、STW、调度延迟。
- [ ] 已用 heap `inuse_objects` 找对象制造者，而不只看 `inuse_space`。
- [ ] 已检查第三方缓存/池的版本与已知 issue，而不只跑 `govulncheck`。
- [ ] 现场短暂的服务已配置 Holmes 自动 dump 或 Pyroscope 持续 profiling。

---

## 10. 原书 20 章覆盖矩阵

| # | 章节 | 核心结论 | 本文位置 |
|---|---|---|---|
| 1 | 序言 | 面向有 Go 基础、想系统提升性能的开发者 | §0 |
| 2 | benchmark 基准测试 | 稳定环境、`-benchmem`、`ResetTimer`、多输入验证复杂度 | §2 |
| 3 | pprof 性能分析 | CPU/内存/阻塞/锁四类 profile，`go tool pprof` 定位热点 | §3 |
| 4 | 字符串拼接 | 循环拼接用 Builder + Grow，`+`/Sprintf 慢约 1000× | §4.1 |
| 5 | 切片性能及陷阱 | 预分配；子切片保留底层数组；删除/插入 O(n) | §4.2 |
| 6 | for 和 range | range 复制元素，大 struct 用下标，指针切片避免复制 | §4.3 |
| 7 | Reflect 性能 | 反射赋值慢 100–1000×；缓存字段下标或代码生成 | §4.6 |
| 8 | 空结构体 | 零大小；Set、信号 channel、纯方法类型 | §4.4 |
| 9 | struct 内存对齐 | 字段顺序影响大小；空结构体末尾填充；对齐与原子性 | §4.5 |
| 10 | 读写锁 vs 互斥锁 | 读多写少 RWMutex 才有优势；写多无优势 | §5.1 |
| 11 | 退出协程（超时） | 无缓冲 channel 导致泄漏；缓冲 1 或非阻塞发送；不能 kill | §5.2 |
| 12 | 退出协程（其他） | 关闭 channel + comma-ok；关闭原则；channel 状态表 | §5.2 |
| 13 | 控制并发数量 | 无界 goroutine 耗尽内存/FD；信号量、worker pool、ulimit | §5.2 |
| 14 | sync.Pool | 复用临时对象降分配；GC 可清空；必须 Reset | §5.3 |
| 15 | sync.Once | 懒初始化、只执行一次；done 在热路径首字段 | §5.4 |
| 16 | sync.Cond | 多等待者条件变量；Wait 必须循环；Broadcast/Signal | §5.5 |
| 17 | 减小二进制体积 | `-s -w` 约 20%，UPX 约 50–70% | §6.3 |
| 18 | 逃逸分析 | 栈 vs 堆；指针/接口/闭包/大对象导致逃逸 | §6.1 |
| 19 | 死码消除 | const 优于 var；debug 常量与 build tags | §6.2 |
| 20 | 数组和切片陷阱 | 数组值拷贝；slice header 拷贝；append 扩容后不互通 | §4.2 / §7 |

原书链接：`https://geektutu.com/post/hpg-benchmark.html`、`hpg-pprof.html`、`hpg-string-concat.html`、`hpg-slice.html`、`hpg-range.html`、`hpg-reflect.html`、`hpg-empty-struct.html`、`hpg-struct-alignment.html`、`hpg-mutex.html`、`hpg-timeout-goroutine.html`、`hpg-exit-goroutine.html`、`hpg-concurrency-control.html`、`hpg-sync-pool.html`、`hpg-sync-once.html`、`hpg-sync-cond.html`、`hpg-reduce-size.html`、`hpg-escape-analysis.html`、`hpg-dead-code-elimination.html`、`hpg-gotchas-array-slice.html`。

附加来源（非原书）：掘金《Golang 高级微调技术》11 条工程技巧 → §12。其中 G3（预分配）、G5（slice 转数组）、G6（`import _`）、G9（interface nil）与性能或正确性直接相关，其余为可读性/工程实践。

pprof 实战四篇（三篇掘金 + 微信《Go 应用性能分析实战》）已并入 §3.2–§3.5：J1 只取 `binary + profile`（§3.2）与 `gctrace` 联动（§6.4）；J2 取采样语义与内存四指标；微信篇取 labels、控制台过滤、`heap?gc=1` 双快照；Goref 篇取对象引用分析及其生产限制。

附加案例与判读：掘金《golang的pprof与火焰图实战》→ §3.6 火焰图判读；微信《一次Go服务可用性抖动的问题排查》→ §3.7 off-CPU/GC assist/自动抓现场。

---

## 11. 版本差异与数据可信度

原书实验集中在 2020 年（go1.13.6 左右），以下结论需要按项目版本 reinterpret：

| 主题 | 原书语境 | 现代 Go（Agent 必读） |
|---|---|---|
| range 循环变量 | 所有迭代共享变量，闭包需 `v := v` | Go 1.22+ 每轮独立变量；但 `go.mod` 的 `go` 指令 < 1.22 仍用旧语义。 |
| range 值复制 | 复制元素 | 未变：`for _, v := range []BigStruct` 仍复制，性能结论仍成立。 |
| slice 扩容 | <1024 翻倍，之后 1.25× | Go 1.18+ 改为约 256 阈值 + 新公式 + size class 取整；不要依赖具体系数。 |
| `sync.Pool` | 对象可能被 GC 清理 | Go 1.13+ 引入 victim cache，仍可能在任意 GC 后消失；语义不变。 |
| build tags | `// +build debug` | Go 1.17+ 用 `//go:build debug`；旧写法仍被识别但已不推荐。 |
| 随机数 | `rand.Seed(time.Now().UnixNano())` | Go 1.20 起 `rand.Seed` 弃用；用 `rand.New(rand.NewSource(seed))` 或 `math/rand/v2`。 |
| 原子操作 | `atomic.AddInt64` 等函数 | Go 1.19+ 优先 `atomic.Int64` 等类型化 API。 |
| 一次性初始化 | `sync.Once` | Go 1.21+ 可用 `sync.OnceValue` / `OnceFunc` / `OnceValues`。 |
| 内存上限 | 手动 `GOGC` | Go 1.19+ 支持 `GOMEMLIMIT`；仍建议先降分配。 |
| benchmark 循环 | `for i := 0; i < b.N; i++` | Go 1.24+ 可用 `for b.Loop()`，自动处理计时与防优化。 |
| pprof 标签 | 无 | Go 1.9+ 支持 `pprof.Labels` / `pprof.Do`；仅 CPU 和 goroutine profile 生效。`[补充]` |
| off-CPU profiling | 无 | fgprof 建议 Go 1.19+；更老版本在 goroutine 多时可能造成明显 STW。`[补充]` |
| 自动抓现场 | 无 | Holmes（`mosn.io/holmes`，Apache-2.0）按阈值自动 dump；dump 本身有开销，需预发验证。`[补充]` |
| 对象引用分析 | 无 | Goref 目标可执行文件支持 go1.19–go1.26，工具编译需 ≥go1.21；依赖 DWARF。`[补充]` |
| 反射替代 | easyjson | 仍可用；也可考虑 protobuf、`encoding/json/v2`（实验性）或代码生成方案，按项目依赖选择。 |

### 数据使用规则

1. 原书数字只用来说明**数量级与方向**（如「快 1000 倍」「内存降到 1/22」），不得写成跨项目承诺。
2. 任何「优化后提升 X%」的结论必须来自当前项目、当前机器、当前 Go 版本的 A/B 测量。
3. 引用原书时必须同时给出处章节；引用现代语义时必须给出 Go 版本。
4. 若测量结果与原书结论冲突，以当前项目的测量为准，并记录环境差异。

---

## 12. 工程技巧补充（附加来源：掘金《Golang 高级微调技术》）

> 来源：`https://juejin.cn/post/7342349357386661914`，原文 *Fine-Tuning Golang: Advanced Techniques for Code Optimization*。该文 11 条技巧偏工程实践与可读性，只有预分配、切片转数组、`import _`、interface nil 与性能/正确性直接相关。原文没有 benchmark 数据，本文不为其背书；涉及性能的结论引用原书实测或标注为补充。

### 12.1 分类总表

| ID | 技巧 | 分类 | 性能收益 | Agent 建议 |
|---|---|---|---|---|
| G1 | `defer` 跟踪函数耗时 | 可观测性 | 低（仅调试） | 测试/临时定位可用，勿进热循环 |
| G2 | 两阶段 `defer` 做 setup/teardown | 代码组织 | 无 | 测试/CLI 可用；生产注意错误处理 |
| G3 | 预分配 slice / map | 内存分配 | 高 | 默认使用，优先 `make([]T, 0, n)` |
| G4 | 链式调用（返回接收者） | API 风格 | 无 | 纯构造器可用；可能隐藏错误 |
| G5 | slice 转数组 / 数组指针 | 类型转换 | 中（值转换会拷贝） | 分清拷贝与别名，检查长度 |
| G6 | `import _` 触发 init | 初始化 | 负（启动成本） | 谨慎；优先显式初始化 |
| G7 | `import .` 点导入 | 可读性 | 无 | 生产代码禁用 |
| G8 | `errors.Join` 合并错误 | 错误处理 | 低 | 非热点；注意遍历与分配成本 |
| G9 | 判断 interface 是否为 nil | 正确性 | 无 | 必须掌握；反射判断要防 panic |
| G10 | JSON 解析 `time.Duration` | 易用性 | 无 | 配置解析可用；注意字符串/数字 |
| G11 | 避免裸参数 | 可读性 | 无 | 推荐；Go 没有命名参数 |

### 12.2 逐条规则

#### G1. 用 defer 跟踪函数耗时

```go
func TrackTime(pre time.Time) time.Duration {
    elapsed := time.Since(pre)
    fmt.Println("elapsed:", elapsed)
    return elapsed
}

func TestTrackTime(t *testing.T) {
    defer TrackTime(time.Now()) // time.Now() 立即求值，打印发生在函数返回时
    time.Sleep(500 * time.Millisecond)
}
```

| 等级 | 规则 |
|---|---|
| SHOULD | 临时定位慢函数时可用；正式性能结论必须来自 benchmark / pprof，而不是日志里的单次耗时。 |
| MUST | `defer f(args)` 的实参在 defer 语句执行时求值；`defer TrackTime(time.Now())` 记录的是进入函数的时间，不是返回时间。 |
| MUST | 不要在每迭代都执行的热循环里打日志计时；I/O 与格式化会主导测量结果。 |
| CONSIDER | 需要拿到返回值时不要用 defer（返回值会被丢弃）；用命名返回值或在函数末尾显式调用。 |

#### G2. 两阶段 defer：setup 返回 cleanup

```go
func setupTeardown() func() {
    fmt.Println("Run initialization")
    return func() { fmt.Println("Run cleanup") }
}

func main() {
    defer setupTeardown()() // 先执行 setup，函数返回时执行 cleanup
    fmt.Println("Main function called")
}
```

| 等级 | 规则 |
|---|---|
| SHOULD | 适合测试夹具、临时目录、分布式锁、数据库连接的成对操作；测试中优先用 `t.Cleanup`。 |
| MUST | setup 阶段可能失败时，这个模式无法把 error 传回调用方；生产代码用显式 `setup() (cleanup func(), err error)`。 |
| MUST | `defer` 写在循环里会推迟到函数返回才执行；循环内需要即时清理时抽成小函数。参见 §7 第 11 条。 |

#### G3. 预分配 slice / map

```go
a := make([]int, 10)    // 长度 10，元素已存在（零值）；a[0] = 1 合法
b := make([]int, 0, 10) // 长度 0、容量 10；配合 append 使用

m := make(map[string]int, 1024) // 容量提示，不是硬上限
```

| 等级 | 规则 |
|---|---|
| MUST | 准备用 `append` 时用 `make([]T, 0, n)`，不要用 `make([]T, n)` 再 append（会先产生 n 个零值元素）。 |
| SHOULD | 已知最终大小时预分配；原书 100 万元素：1 次分配 / 8MB vs 40 次分配 / 45MB。参见 S8。 |
| CONSIDER | map 的容量参数用于预估 bucket 数量、减少扩容；它不是硬上限，超出后仍会增长。`[补充]` |

#### G4. 链式调用（fluent API）

```go
func (p *Person) AddAge() *Person   { p.Age++; return p }
func (p *Person) Rename(s string) *Person { p.Name = s; return p }

p = p.AddAge().Rename("Aiden 2")
```

| 等级 | 规则 |
|---|---|
| CONSIDER | 只用于无错误、纯内存修改的构造器/Builder；可读性收益因团队而异。 |
| MUST | 方法可能返回 error 时不要链式隐藏；`a().b()` 中任何一步失败都难以逐段处理。 |
| MUST | 返回接收者不改变性能；不要把它当优化手段。 |

#### G5. slice 转数组 / 数组指针

```go
a := []int{0, 1, 2, 3, 4, 5}

b := [3]int(a[:3])     // Go 1.20+：值转换，复制 3 个元素
p := (*[3]int)(a[:3])  // Go 1.17+：数组指针，零拷贝，仍指向 a 的底层数组
```

| 等级 | 规则 |
|---|---|
| MUST | 值转换 `[N]T(s)` 会复制 N 个元素；指针转换 `(*[N]T)(s)` 零拷贝但与原 slice 别名，修改会互相影响。 |
| MUST | 两种转换在 `len(s) < N` 时都会 panic；转换前必须保证长度。 |
| CONSIDER | 需要快照/脱钩用值转换；需要零拷贝且能证明生命周期用指针转换。 |
| MUST | 区分版本：Go 1.17 加入 slice→数组指针，Go 1.20 加入 slice→数组值；`go.mod` 版本低于对应版本时不能编译。 |

#### G6. `import _`：只执行 init

```go
import _ "google.golang.org/genproto/googleapis/api/annotations"
```

| 等级 | 规则 |
|---|---|
| SHOULD | 仅用于确实需要副作用注册的包（驱动注册、codec 注册、protobuf 注解）。 |
| MUST | `init` 在 `main` 之前执行，重初始化会拖慢启动且难以测试；库代码不要放大块逻辑进 `init`。 |
| CONSIDER | 能用显式 `Register()` / 懒初始化（`sync.Once`）替代时优先替代，便于控制顺序与错误。参见 §5.4、§6.2。 |

#### G7. `import .`：点导入

```go
import (
    "fmt"
    . "math"
)

fmt.Println(Pi) // 不需要 math.Pi
```

| 等级 | 规则 |
|---|---|
| MUST | 生产代码禁用点导入：污染命名空间、无法看出标识符来源、与本地变量冲突时难排查。 |
| CONSIDER | 仅测试、DSL 或迁移兼容层可少量使用；`staticcheck` 的 ST1001 会提示。 |

#### G8. `errors.Join` 合并多个错误

```go
err := errors.Join(err1, err2)
fmt.Println(errors.Is(err, err1)) // true
fmt.Println(errors.Is(err, err2)) // true
```

| 等级 | 规则 |
|---|---|
| SHOULD | Go 1.20+ 合并多个独立错误；全部为 nil 时返回 nil。 |
| MUST | `errors.Is/As` 需要遍历错误树，`Join` 也会分配；不要在高频热路径用它拼接错误。 |
| CONSIDER | 单个错误用 `%w` 包装；多个错误才用 `Join`。需要结构化多错误时可用 `errors.Join` + 自定义 `Unwrap() []error`。 |

#### G9. 判断 interface 是否真的为 nil

```go
var x any
var y *int = nil
x = y
fmt.Println(x != nil) // true：类型信息非 nil，值是 nil

func IsNil(x any) bool {
    if x == nil {
        return true
    }
    v := reflect.ValueOf(x)
    switch v.Kind() {
    case reflect.Chan, reflect.Func, reflect.Interface,
        reflect.Map, reflect.Pointer, reflect.Slice:
        return v.IsNil()
    default:
        return false
    }
}
```

| 等级 | 规则 |
|---|---|
| MUST | 接口持有 typed nil 时 `x != nil` 为 true；不要用 `== nil` 判断「底层值是否为 nil」。 |
| MUST | `reflect.ValueOf(x).IsNil()` 只对 chan/func/interface/map/pointer/slice 合法，对其他 Kind 会 panic；必须先判 `x == nil` 再按 Kind 分支。 |
| SHOULD | 设计 API 时避免返回 typed nil：返回具体类型时显式返回 `nil` 接口，或让调用方用具体类型判空。参见 §7 第 14 条。 |

#### G10. JSON 中解析 `time.Duration`

```go
type Duration time.Duration

func (d *Duration) UnmarshalJSON(b []byte) error {
    if d == nil {
        return errors.New("Duration: nil receiver")
    }
    var s string
    if err := json.Unmarshal(b, &s); err != nil {
        return err
    }
    dur, err := time.ParseDuration(s) // "1s"、"20h5m"
    if err != nil {
        return err
    }
    *d = Duration(dur)
    return nil
}
```

| 等级 | 规则 |
|---|---|
| SHOULD | 配置文件中用 `"1s"`、`"20h5m"` 比裸纳秒整数可读；自定义类型集中解析逻辑。 |
| MUST | 该实现只接受 JSON 字符串；JSON 数字会解析失败。需要兼容数字时额外处理 `json.Number`。 |
| MUST | 指针接收者要判 `d == nil`；否则赋值时 panic。原文「变量 d 不能为零」应理解为不能为 nil。 |
| CONSIDER | 需要输出时同时实现 `MarshalJSON`，保证读写格式对称。 |

#### G11. 避免裸参数

```go
// func printInfo(name string, isLocal, done bool)

printInfo("foo", true /* isLocal */, true /* done */)
```

| 等级 | 规则 |
|---|---|
| SHOULD | 多个同类型布尔/字符串参数时，用行内注释、选项结构体或专用类型提升可读性。 |
| CONSIDER | Go 没有命名参数；注释可能随参数改动漂移，API 边界优先用 `type Local bool` 或 `Options struct`。 |
| MUST | 这是可读性技巧，不产生运行时收益；不要为「性能」引入。 |

### 12.3 原文纠偏（Agent 必读）

| # | 原文表述 | 准确说法 |
|---|---|---|
| 1 | `make([]int, 10)` 是「不推荐」的预分配 | 它表示长度 10 的 slice，本身没有错；错的是随后 `append` 却期望从 0 开始。按用途选择 `make([]T, n)` 或 `make([]T, 0, n)`。 |
| 2 | `reflect.ValueOf(x).IsNil()` 可直接判断 interface 是否为 nil | 只对可空 Kind 合法；对 int/string/struct 会 panic，必须先判 `x == nil` 并分支 Kind。 |
| 3 | Go 1.17/1.20 都叫「slice 转数组」 | Go 1.17 是转**数组指针**（零拷贝、别名）；Go 1.20 是转**数组值**（复制）。语义与成本不同。 |
| 4 | `Duration.UnmarshalJSON` 可直接解析 | 只处理 JSON 字符串；数字、null、nil 接收者都要额外处理，否则报错或 panic。 |

### 12.4 与正文的交叉引用

| 附加技巧 | 正文关联 |
|---|---|
| G2 两阶段 defer | §7 第 11 条「defer 写在循环里」 |
| G3 预分配 | §4.2 S8、S9 |
| G5 slice 转数组 | §4.2 S10（别名与底层数组）、S16（数组值语义） |
| G6 `import _` | §5.4（懒初始化）、§6.2（DCE 与 init 成本） |
| G9 interface nil | §7 第 14 条 |
| G1 计时 | §2（benchmark）、§3（pprof） |

---

## 13. 一页速记（Agent 上下文紧张时只读这里）

```
先测再改：profile → 假设 → 单点改动 → benchstat → 回滚或保留
CPU：pprof cpu；内存：heap(inuse vs alloc)；阻塞：block；锁：mutex
字符串循环拼接：strings.Builder + Grow（不要 + / Sprintf）
切片：make([]T,0,n)；子切片长期持有要 copy；删除/插入 O(n)
range：大元素用下标；value 是副本；Go 1.22 才修循环变量
反射：热点禁用 FieldByName；缓存 Name→Index 或代码生成
锁：默认 Mutex；读多写少才 RWMutex；不持锁做 I/O
goroutine：每个都要能退出；超时发送用缓冲 1 / select-default；不能 kill
并发上限：信号量 / errgroup.SetLimit / worker pool
Pool：临时对象；Get 后 Reset；Put 前清引用；GC 会清空
一次初始化：sync.Once；panic 也算完成
二进制：-ldflags="-s -w"、-trimpath；UPX 按需
逃逸：-gcflags=-m；少用 any、少返回指针、别造超大局部对象
提交：gofmt + go vet + go test -race + benchstat，收益 <5% 就回滚
工程：append 用 make([]T,0,n)；slice→数组指针零拷贝、数组值拷贝；import _ 有启动成本；typed nil != nil
内存：heap?gc=1 两次快照 + diff_base；找不到持有者用 Goref（attach 会暂停进程，优先 gcore）
```
