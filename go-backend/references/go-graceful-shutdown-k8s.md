---
title: "Go 在 Kubernetes 中的 Graceful Shutdown：代码技巧与库选型"
source: "https://victoriametrics.com/blog/go-graceful-shutdown/index.html"
derived_from: "VictoriaMetrics《Graceful Shutdown in Go: Practical Patterns》 + Kubernetes Pod 终止语义"
audience: "Go 后端工程师 / AI coding agents"
go_version: "示例基于 Go 1.22+；signal.NotifyContext 需 1.16+，atomic.Bool 需 1.19+"
last_updated: "2026-11-11"
---

# Go 在 Kubernetes 中的 Graceful Shutdown

> **Playbook 入口**：[SKILL.md](../SKILL.md) · **相关模块**：[性能手册](go-performance-agent-guide.md) · [常用库与代码 Tips](go-libraries-and-tips.md)

> 本文只讨论**正确性、可用性与资源释放**，不讨论性能调优。核心目标：滚动发布、缩容、节点回收时，不丢请求、不丢消息、不写坏数据。

## 0. 结论先行

Graceful shutdown 的最小正确模型只有四步：

1. **停止新流量进入**：readiness 立即返回 503，并等待探针周期 + 负载均衡传播。
2. **停止接收新请求**：`http.Server.Shutdown(ctx)` 关闭 listener，不再接受新连接。
3. **等待在途工作完成**：用带超时的 context 等待 HTTP handler、gRPC RPC、队列消息处理完。
4. **按逆序释放资源**：停消费者 → flush 生产者 → 关 DB/cache → flush telemetry/log。

K8s 场景下，真正容易出错的不是 `Shutdown` 调用本身，而是**时序**：

- Pod 被删除后，Endpoint/EndpointSlice 的移除是异步的；SIGTERM 到达时，可能仍有流量打进来。
- `preStop` 的耗时**计入** `terminationGracePeriodSeconds`，不是额外赠送。
- 外部负载均衡器不依赖 kube-proxy，健康检查传播可能更慢。
- `SIGKILL` 不可捕获；超时后进程直接消失，未完成的写入/提交全部丢失。

---

## 1. Kubernetes 终止流程与时间预算

### 1.1 终止时间线

```
T0  kubectl delete / rollout / node drain
    │  API Server 设置 deletionTimestamp，Pod 进入 Terminating
    │  EndpointSlice 控制器开始把该 Pod 标记为 terminating（异步）
    │  kube-proxy / Ingress 逐步停止转发新流量（异步）
    │
    ├─ kubelet 执行 preStop hook（如果配置了）
    │     └─ 耗时计入 terminationGracePeriodSeconds
    │
    ├─ kubelet 向容器 PID 1 发送 SIGTERM
    │     └─ 应用开始 drain：readiness 失败、等待传播、Shutdown
    │
    ├─ 到达 terminationGracePeriodSeconds
    │     └─ kubelet 发送 SIGKILL，进程立即终止
    ▼
```

关键事实：

| 事实 | 含义 |
|---|---|
| 宽限期从 **deletionTimestamp** 开始计时 | 不是从 SIGTERM 开始；preStop 已经消耗预算。 |
| `preStop` 在 SIGTERM **之前**执行 | 适合做“先摘流量，再等一会儿”。 |
| Endpoint 移除是异步的 | SIGTERM 到达时，仍可能收到新请求。 |
| 外部 LB 独立于 K8s | 它按自己的健康检查节奏摘节点，可能比 kube-proxy 慢很多。 |
| SIGKILL 不可捕获 | 所有清理必须在宽限期内完成；超时即丢数据。 |
| 多容器 Pod 共享宽限期 | 每个容器都会收到 SIGTERM，但预算不是每容器一份。 |

### 1.2 预算公式

```
terminationGracePeriodSeconds
  ≥ preStop
  + readiness 传播时间（probe period × failureThreshold + LB 传播）
  + 应用 shutdown 超时
  + 强制退出前的安全余量
```

示例（默认 30s）：

| 阶段 | 预算 | 说明 |
|---|---|---|
| readiness 传播 | 5s | probe `periodSeconds=5`，再加 LB 传播 |
| 等待在途请求 | 15s | `server.Shutdown(ctx)` 的超时 |
| 强制取消后等待 | 3s | `Close()` 后给 handler 一点时间退出 |
| 安全余量 | 7s | 避免卡在边界被 SIGKILL |
| **合计** | **30s** | 与默认宽限期一致 |

> 上表按“代码内 drain、没有 preStop sleep”计算。如果再加 `preStop: sleep 5`，要么把 `terminationGracePeriodSeconds` 提到 35s，要么把 shutdown 超时从 15s 降到 10s；不要直接在 30s 预算里硬塞 5s。

> 原文建议预留约 20% 余量：30s 宽限期按 25s 设计。这个比例是经验值，不是规范；关键是**把最坏情况算进去**。

### 1.3 探针怎么配

| 探针 | 排空期间的行为 | 原因 |
|---|---|---|
| readiness | **立即 503** | 让 Endpoint/Ingress/LB 尽快摘流量。 |
| liveness | **保持 200** | 排空期间不要让 kubelet 误判并重启容器。 |
| startup | 与排空无关 | 只负责慢启动保护。 |

readiness 的检测延迟约为 `periodSeconds × failureThreshold`，再加上负载均衡器自己的探测周期。不要只等一个 probe 周期就 `Shutdown`。

> 如果 liveness 与业务共用同一个 HTTP server，`Shutdown` 之后探针会连接失败。Pod 已在 Terminating，通常不会因此重启；更稳妥的做法是把 health 端点放在独立的管理端口/独立 server，并让它保持到进程退出。

---

## 2. Go 信号处理

### 2.1 最小正确写法

```go
ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
defer stop()

// 启动服务...
<-ctx.Done()

// 恢复默认信号行为：第二次 SIGTERM/SIGINT 可以直接杀死进程
stop()
```

`signal.NotifyContext` 从 Go 1.16 开始可用。它把“收到信号”转成 context 取消，适合作为整个应用的根 context。

### 2.2 为什么信号 channel 要缓冲 1

如果不用 `NotifyContext`，而是手写：

```go
sigCh := make(chan os.Signal, 1)
signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
```

缓冲 1 的目的是：应用还在初始化、尚未执行到 `<-sigCh` 时，第一个信号不会因为无人接收而丢失。Go 内部向 channel 发送信号时使用非阻塞发送：

```go
select {
case c <- sig:
default:
}
```

无缓冲 channel 且没有接收者时，信号会被丢弃。

### 2.3 第二次信号强制退出

默认情况下，连续按两次 `Ctrl+C` 仍然是两次 `SIGINT`，终端不会自动升级成 `SIGKILL`。如果希望第二次直接退出：

```go
<-ctx.Done()
stop() // 取消 NotifyContext 的注册，恢复默认处理
```

之后再来一次 SIGTERM/SIGINT，Go runtime 会走默认行为，进程终止。注意：这会跳过你的剩余清理逻辑，是有意为之的“逃生通道”。

### 2.4 只捕获该捕获的

- 捕获 `SIGTERM`、`SIGINT` 即可；K8s 发的是 `SIGTERM`。
- `SIGHUP` 通常用于 reload 配置，不要拿它当常规关闭信号。
- `SIGKILL` 不可捕获、不可忽略；不要尝试处理。
- Windows 不支持 Unix 信号；本文的部署目标是 Linux 容器。

### 2.5 PID 1 与 shell wrapper

K8s 把 SIGTERM 发给容器内的 **PID 1**。如果 Dockerfile 写成：

```dockerfile
CMD ["/bin/sh", "-c", "./app"]
```

shell 可能不会把 SIGTERM 转发给 `./app`，导致应用收不到关闭信号，最后被 SIGKILL。应使用 exec form：

```dockerfile
ENTRYPOINT ["/app"]
```

或者在脚本中使用 `exec ./app`。如果必须用 shell 做初始化，使用 `tini`、`dumb-init` 等 init 进程转发信号。

---

## 3. HTTP 服务：推荐模板

### 3.1 完整模板

```go
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"
)

const (
	readinessDrainDelay = 5 * time.Second
	shutdownTimeout     = 15 * time.Second
	hardStopWait        = 3 * time.Second
)

func main() {
	// 逻辑放进 run()，让 defer 一定执行；main 只负责退出码。
	if err := run(); err != nil {
		log.Printf("fatal: %v", err)
		os.Exit(1)
	}
}

func run() error {
	rootCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	var draining atomic.Bool

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if draining.Load() {
			http.Error(w, "draining", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/livez", func(w http.ResponseWriter, r *http.Request) {
		// 排空期间保持 200，避免被 liveness 重启
		w.WriteHeader(http.StatusOK)
	})
	// 可选：给 preStop 调用的本地 drain 端点
	mux.HandleFunc("/internal/drain", func(w http.ResponseWriter, r *http.Request) {
		draining.Store(true)
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(2 * time.Second):
			fmt.Fprintln(w, "hello")
		case <-r.Context().Done():
			http.Error(w, "request cancelled", http.StatusRequestTimeout)
		}
	})

	// BaseContext 派生给所有请求；Shutdown 超时后再 cancel，作为最后手段。
	baseCtx, cancelBase := context.WithCancel(context.Background())
	defer cancelBase()

	srv := &http.Server{
		Addr:              ":8080",
		Handler:           mux,
		BaseContext:       func(net.Listener) context.Context { return baseCtx },
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		// WriteTimeout 视业务而定：长响应/流式接口不要设得过短。
	}

	errCh := make(chan error, 1)
	go func() {
		log.Printf("listening on %s", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return fmt.Errorf("http server: %w", err)
	case <-rootCtx.Done():
	}

	// 1) 先摘流量：readiness 失败
	stop() // 恢复默认信号行为，允许第二次信号强制退出
	draining.Store(true)
	log.Println("draining: readiness -> 503")

	// 2) 等待 probe 与 LB 传播；这段时间不要 Shutdown
	time.Sleep(readinessDrainDelay)

	// 3) 停止接收新请求，等待在途请求
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	err := srv.Shutdown(shutdownCtx)
	if err != nil {
		log.Printf("graceful shutdown incomplete: %v", err)
		_ = srv.Close() // 强制断开连接
		time.Sleep(hardStopWait)
	}

	// 4) 最后取消请求上下文，确保残留 handler 尽快返回
	cancelBase()

	log.Println("shutdown complete")
	return nil
}
```

### 3.2 `Shutdown` 的精确语义

`http.Server.Shutdown(ctx)` 会：

1. 关闭所有 listener，停止接受新连接；
2. 关闭空闲连接；
3. 等待活跃连接上的请求处理完；
4. `ctx` 到期时返回 `ctx.Err()`，但**未完成的 handler 仍在运行**。

因此：

```go
err := srv.Shutdown(ctx)
if err != nil {
	// 不代表进程已经安全；只是“没能在预算内等完”
	_ = srv.Close()
	// 短等待后由进程退出兜底
}
```

`nil` 才表示所有活跃请求已完成。

### 3.3 `Shutdown` vs `Close`

| 方法 | 行为 | 适用 |
|---|---|---|
| `Shutdown(ctx)` | 停止接收新连接，等待活跃请求完成，关闭空闲连接 | 正常关闭 |
| `Close()` | 立即关闭 listener 和所有连接 | 超时后的强制兜底 |

`Close()` 的副作用：

- 正在读写网络的 handler 会收到错误；
- 客户端可能看到 `ECONNRESET` / `socket hang up`；
- 只在 CPU 计算、不碰网络的 handler 可能继续运行到函数返回。

所以 `Close()` 不能替代 `Shutdown()`；它只适合超时后的最后手段。

### 3.4 `ErrServerClosed` 不是错误

```go
if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
	// 真正的启动/运行错误
}
```

`Shutdown`/`Close` 会让 `ListenAndServe` 返回 `http.ErrServerClosed`。把它当错误会让正常关闭走进 panic/exit 分支。

### 3.5 容易被忽略的连接类型

| 类型 | `Shutdown` 是否等待 | 需要做什么 |
|---|---|---|
| 普通 HTTP 请求 | 是 | 无需额外处理 |
| Keep-alive 空闲连接 | 不等待，直接关闭 | 无需额外处理 |
| WebSocket / Hijacked 连接 | **否** | 自己维护连接表，发 close frame，关闭连接 |
| SSE / 长轮询 | 是（handler 不返回就一直等） | 用 context/停止信号让 handler 退出 |
| HTTP/2 活跃流 | 是 | 注意客户端重试与 GOAWAY 行为 |

官方文档明确：`Shutdown` **不会关闭也不会等待 hijacked 连接**（例如 WebSocket）。如果服务有 WebSocket：

```go
var (
	wsMu    sync.Mutex
	wsConns = map[*websocket.Conn]struct{}{}
)

// 在关闭流程中：
wsMu.Lock()
for c := range wsConns {
	_ = c.WriteControl(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseGoingAway, "server shutdown"),
		time.Now().Add(time.Second))
	_ = c.Close()
}
wsMu.Unlock()
```

### 3.6 Server 超时参数

```go
srv := &http.Server{
	ReadHeaderTimeout: 5 * time.Second,  // 防慢速 header 攻击
	ReadTimeout:       30 * time.Second, // 视上传场景
	WriteTimeout:      30 * time.Second, // 流式接口慎用
	IdleTimeout:       60 * time.Second,
}
```

这些参数与 graceful shutdown 的关系：

- `Shutdown` 不会打断正在执行的 handler，即使超过 `WriteTimeout`；
- 连接空闲超过 `IdleTimeout` 会被关闭；
- 长连接/流式接口不应设置过短的 `WriteTimeout`，否则正常业务会被截断。

---

## 4. 请求上下文与取消传播

### 4.1 为什么 handler 需要感知关闭

`Shutdown` 只是“等待 handler 返回”。如果 handler 内部阻塞在：

- `time.Sleep(10 * time.Second)`
- `context.Background()` 派生的 DB 查询
- 没有超时的 HTTP client 调用
- 永久阻塞的 channel 接收

那么 `Shutdown` 只能等到 context 超时，然后 `Close()`，最后进程退出。**能被取消的工作，才谈得上优雅关闭。**

### 4.2 两种注入方式

**方式 A：`BaseContext`（推荐给全局关闭）**

```go
baseCtx, cancelBase := context.WithCancel(context.Background())
srv := &http.Server{
	BaseContext: func(net.Listener) context.Context { return baseCtx },
}
// 关闭时：
cancelBase()
```

所有连接派生的请求 context 都继承 `baseCtx`。取消它等于通知所有在途请求“该结束了”。

**方式 B：中间件（适合按请求/路由控制）**

```go
func WithShutdownContext(next http.Handler, done <-chan struct{}) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()

		go func() {
			select {
			case <-done:
				cancel()
			case <-ctx.Done():
			}
		}()

		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
```

注意：每个请求起一个 goroutine 有成本；高 QPS 下优先 `BaseContext`，或复用全局 context。

### 4.3 handler 必须 select context

```go
func handler(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	select {
	case <-time.After(2 * time.Second):
		fmt.Fprintln(w, "done")
	case <-ctx.Done():
		http.Error(w, "cancelled", http.StatusRequestTimeout)
	}
}
```

DB 调用用 `QueryContext`，HTTP 调用用 `NewRequestWithContext`：

```go
req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
rows, err := db.QueryContext(ctx, "SELECT ...")
```

### 4.4 可取消的 sleep

```go
func Sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()

	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
```

不要用 `time.Sleep` 替代；它不响应取消。

> Go 1.23 起，未被引用的 timer 可以被 GC；更早版本中 `time.After` 在触发前可能一直占内存。若需兼容旧版本，用 `time.NewTimer` + `Stop`。

### 4.5 常见上下文错误

| 错误 | 后果 | 修复 |
|---|---|---|
| handler 内用 `context.Background()` 查 DB | 关闭时查询不会被取消 | 用 `r.Context()` |
| 起 goroutine 时传 `r.Context()` 但不等它结束 | Shutdown 返回后 goroutine 仍可能写响应 | 用 `errgroup`/`WaitGroup` 跟踪 |
| 用 `time.Sleep` 模拟业务 | 不响应取消 | 用可取消 sleep |
| 取消 context 后继续写响应 | 客户端可能收到部分响应 | 先检查 `ctx.Err()`，再决定是否写 |
| 把请求 context 存到全局 | 请求结束后被取消，后续使用失败 | 只在该请求生命周期内使用 |

---

## 5. 后台任务、队列与 gRPC

### 5.1 用 errgroup 管多个组件

```go
g, ctx := errgroup.WithContext(rootCtx)

g.Go(func() error { return httpServer.Run(ctx) })
g.Go(func() error { return consumer.Run(ctx) })
g.Go(func() error { return metricsServer.Run(ctx) })

if err := g.Wait(); err != nil && !errors.Is(err, context.Canceled) {
	return err
}
```

注意：`errgroup.WithContext` 在任意一个 goroutine 返回错误时会取消 `ctx`。如果某个组件正常退出也返回 `context.Canceled`，需要显式忽略，避免误判。

### 5.2 队列消费者的关闭顺序

以 Kafka 为例：

1. 停止拉取新消息（取消 poll 循环）；
2. 等待当前批次/在途 handler 完成；
3. 提交 offset（只提交已成功处理的）；
4. flush producer；
5. 关闭 consumer。

```go
func (c *Consumer) Run(ctx context.Context) error {
	for {
		m, err := c.reader.FetchMessage(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return nil
			}
			return err
		}

		if err := c.handle(ctx, m); err != nil {
			return err
		}
		// 关闭时 ctx 可能已被取消；提交用独立的短超时 context，
		// 避免“已处理但未提交”导致重复消费。
		commitCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		err = c.reader.CommitMessages(commitCtx, m)
		cancel()
		if err != nil {
			return err
		}
	}
}
```

> 关键点：不要在 `ctx` 已取消后继续用同一个 `ctx` 提交 offset。提交应该发生在 `handle` 成功之后，并使用独立的、有界的 context。

关闭时不要先 `reader.Close()` 再等 handler；先停止拉取并等处理完，最后关闭。不同库的 `Close` 语义不同，见 §9。

### 5.3 gRPC 的 GracefulStop

```go
healthSrv.SetServingStatus("", healthpb.HealthCheckResponse_NOT_SERVING)

done := make(chan struct{})
go func() {
	srv.GracefulStop()
	close(done)
}()

select {
case <-done:
case <-time.After(shutdownTimeout):
	srv.Stop() // 强制停止
}
```

- `GracefulStop()` 停止接受新 RPC，等待进行中的 RPC 完成；
- 长连接/流式 RPC 可能让它一直阻塞，所以必须配超时 + `Stop()`；
- `Serve()` 返回 `grpc.ErrServerStopped` 属正常，不要当错误；
- 先把 health 服务设为 `NOT_SERVING`，让客户端/负载均衡器停止选它。

### 5.4 定时任务

```go
ticker := time.NewTicker(interval)
defer ticker.Stop()

for {
	select {
	case <-ctx.Done():
		return nil
	case <-ticker.C:
		if err := job(ctx); err != nil {
			log.Printf("job: %v", err)
		}
	}
}
```

关闭时等待当前 `job` 返回；如果 job 可能长时间运行，给它单独的 context 超时，或把任务拆成可中断的步骤。

### 5.5 WebSocket / SSE

- WebSocket 是 hijacked 连接，`Shutdown` 不等待；必须自己维护连接并主动关闭。
- SSE 是普通 HTTP 响应，handler 不返回就会拖住 `Shutdown`；用 `ctx.Done()` 或广播 channel 让 handler 退出。
- 关闭顺序：先停止接受新连接/新订阅，再通知现有连接，最后等待写缓冲 flush。

---

## 6. 资源释放顺序

### 6.1 逆序关闭

按初始化顺序的**反序**关闭，尊重依赖关系：

```
初始化：DB → Cache → Producer → Consumer → HTTP Server
关闭：  HTTP Server → Consumer → Producer → Cache → DB
```

`defer` 天然是 LIFO：

```go
db := connectDB()
defer db.Close()

cache := connectCache()
defer cache.Close()
```

后 defer 的 cache 先关闭，符合逆序。但前提是：**不要在关闭路径里 `os.Exit` / `log.Fatal`**，否则 defer 不会执行。

### 6.2 各资源的关闭语义

| 资源 | 方法 | 注意 |
|---|---|---|
| `database/sql` | `DB.Close()` | 阻止新查询，并等待已开始的查询完成；可能阻塞，先取消请求 context。 |
| `pgxpool` | `Pool.Close()` | 阻止新 Acquire，等待所有连接归还后关闭。 |
| Redis | `Client.Close()` | 关闭连接池；先确保在途命令完成或可丢弃。 |
| MongoDB | `Client.Disconnect(ctx)` | 传带超时的 context。 |
| Kafka producer | `Writer.Close()` | 通常 flush 缓冲；确认是否丢消息。 |
| Kafka consumer | `Reader.Close()` / `ConsumerGroup.Close()` | 停止拉取、提交 offset、离开 group；语义按库确认。 |
| NATS | `Conn.Drain()` | 取消订阅、排空待处理消息、flush、关闭；比 `Close()` 更优雅。 |
| RabbitMQ | `Channel.Close()` / `Conn.Close()` | 等待 publisher confirm；确认未 ack 的消息处理完。 |
| OpenTelemetry | `TracerProvider.Shutdown(ctx)` / `MeterProvider.Shutdown(ctx)` | 最后执行，flush 缓冲的 span/metric。 |
| 日志 | `logger.Sync()` | 最后执行；注意某些 logger 的 Sync 在终端会报错。 |

### 6.3 不要提前关闭资源

常见错误：

```go
<-sigCh
db.Close()        // 错：handler 还在用 DB
srv.Shutdown(ctx) // 太晚
```

正确顺序是：先 stop accepting + wait in-flight，再关 DB。否则在途请求会拿到 `sql: database is closed`。

### 6.4 `DB.Close()` 可能阻塞

`database/sql.DB.Close()` 会等待已开始的查询完成。如果某个查询不响应 context，`Close()` 可能一直阻塞，最终被 SIGKILL。

建议：

1. 关闭前先 `cancelBase()`，让 `QueryContext` 收到取消；
2. 给 DB 关闭留出短预算；
3. 如果 `Shutdown` 已经超时，优先让进程退出，不要无限等待 `DB.Close()`。

---

## 7. Kubernetes 配置模板

### 7.1 Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  replicas: 3
  strategy:
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  selector:
    matchLabels:
      app: app
  template:
    metadata:
      labels:
        app: app
    spec:
      # 若启用下面 preStop 的 5s sleep，应改为 35s，或把应用 shutdown 超时降到 10s。
      terminationGracePeriodSeconds: 30
      containers:
        - name: app
          image: example/app:1.0.0
          ports:
            - containerPort: 8080
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
            periodSeconds: 2
            failureThreshold: 2
          livenessProbe:
            httpGet:
              path: /livez
              port: 8080
            periodSeconds: 10
            failureThreshold: 3
          startupProbe:
            httpGet:
              path: /livez
              port: 8080
            periodSeconds: 2
            failureThreshold: 30
          lifecycle:
            preStop:
              exec:
                # 可选：仅当外部 LB 不依赖 readiness 时使用；
                # 若代码内已有 drain sleep，需从预算中扣除，不要重复叠加。
                command: ["/bin/sh", "-c", "sleep 5"]
```

### 7.2 两种 drain 方案

**方案 A：代码内 readiness + 延迟（推荐）**

- SIGTERM 到达后，`draining.Store(true)`，`/healthz` 返回 503；
- `time.Sleep(readinessDrainDelay)` 等待探针和 LB 传播；
- 再 `Shutdown`。

优点：不依赖镜像里有 `curl`/`wget`；K8s 内外都能用。
缺点：SIGTERM 之前的时间没有利用；如果外部 LB 传播很慢，drain delay 要足够长。

**方案 B：preStop 先摘流量再 sleep**

```yaml
lifecycle:
  preStop:
    exec:
      command: ["/bin/sh", "-c", "sleep 10"]
```

优点：简单，适用于不检查 readiness 的外部 LB。
缺点：不改变 readiness；`preStop` 时间计入宽限期；10s + 15s shutdown 可能超过 30s。

**方案 C：preStop 调 drain 端点 + 代码内延迟（组合）**

```yaml
lifecycle:
  preStop:
    httpGet:
      path: /internal/drain
      port: 8080
```

`/internal/drain` 只做 `draining.Store(true)` 并返回；随后 kubelet 发送 SIGTERM，应用再等待传播并 `Shutdown`。这样 preStop 不占用额外 sleep，又能尽早让 readiness 失败。

> 安全：`/internal/drain` 不要暴露到公网；只监听 localhost/管理端口，或在网关层限制。

### 7.3 参数计算

| 参数 | 取值依据 |
|---|---|
| `terminationGracePeriodSeconds` | preStop + probe/LB 传播 + shutdown 超时 + 余量 |
| readiness `periodSeconds` | 越小摘流量越快，但探针开销越大；常用 2–5s |
| readiness `failureThreshold` | 通常 2–3；与 period 相乘得到检测延迟 |
| liveness `periodSeconds` | 10s 左右；不要与 readiness 共用同一逻辑 |
| `shutdownTimeout` | 略大于 P99 请求耗时，且不超过宽限期预算 |
| `preStop` sleep | 仅覆盖 LB 传播，不要把整个 shutdown 预算花在这里 |

### 7.4 滚动更新与 PDB

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: app
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: app
```

- `maxUnavailable: 0` + `maxSurge: 1` 让滚动更新先起新 Pod，再删旧 Pod；
- PDB 保护节点 drain 等自愿中断；
- 副本数少时，任何 shutdown 都可能导致容量下降，需要预留冗余。

---

## 8. 常见错误

| # | 错误 | 现象 | 修复 |
|---|---|---|---|
| 1 | 只监听 `SIGINT` | K8s 发 `SIGTERM`，进程被直接杀死 | 同时监听 `SIGINT`、`SIGTERM` |
| 2 | 信号 channel 无缓冲 | 初始化期间收到信号会丢失 | `make(chan os.Signal, 1)` 或 `NotifyContext` |
| 3 | 收到信号立刻 `server.Close()` | 在途请求连接被重置 | 先 `Shutdown`，超时才 `Close` |
| 4 | `Shutdown(context.Background())` | 无限等待，直到 SIGKILL | 用 `context.WithTimeout` |
| 5 | 忽略 `Shutdown` 返回的错误 | 未完成就退出，丢请求 | 检查 error，必要时 `Close` + 短等待 |
| 6 | 先关 DB 再停 HTTP | 在途查询报 `database is closed` | 先停流量、等请求，再关 DB |
| 7 | readiness 排空期间仍返回 200 | 新流量继续进来 | 立即返回 503 |
| 8 | liveness 排空期间返回 503 | 可能被 kubelet 重启 | 排空期间保持 200 |
| 9 | preStop sleep + drain + shutdown 超预算 | 到点 SIGKILL，清理未完成 | 按 §1.2 公式计算 |
| 10 | 没有 preStop/drain，外部 LB 传播慢 | 发布时 502/connection refused | readiness 失败 + 等待传播，或 preStop |
| 11 | 后台 goroutine 未跟踪 | 主函数返回，任务半途而废 | errgroup/WaitGroup + context |
| 12 | handler 用 `context.Background()` | 取消信号传不进去 | 用 `r.Context()` |
| 13 | 用 `time.Sleep` 做业务等待 | 关不掉，拖到超时 | 可取消 sleep / select ctx |
| 14 | 关闭路径调用 `os.Exit`/`log.Fatal` | defer 不执行，资源未 flush | 逻辑放 `run() error`，main 统一退出 |
| 15 | shell 包装导致 SIGTERM 不转发 | 应用收不到信号 | exec form / `exec` / tini |
| 16 | WebSocket 连接未主动关闭 | `Shutdown` 不等待 hijacked 连接 | 维护连接表并主动 close |
| 17 | gRPC `GracefulStop` 无超时 | 流式 RPC 让它永久阻塞 | goroutine + timeout + `Stop()` |
| 18 | 宽限期小于最长请求耗时 | 长请求必被 SIGKILL | 提高宽限期或限制请求时长 |
| 19 | 认为 SIGTERM 时 Endpoint 已移除 | 仍有新请求打进来 | readiness + drain delay |
| 20 | 多副本同时滚动，容量不足 | 发布期间 5xx/超时 | `maxUnavailable: 0` + 冗余副本 |

---

## 9. 库推荐

### 9.1 原则

1. **标准库优先**：`os/signal`、`context`、`net/http` 已经覆盖大部分场景。
2. **框架有原生方法就用原生方法**，不要自己包一层信号处理。
3. **客户端库优先用它自己的 Drain/Close**，因为只有它知道 offset、flush、连接池的语义。
4. **不要引入已归档的 graceful 库**：它们大多早于 `http.Server.Shutdown`，功能被标准库覆盖。

### 9.2 推荐表

| 需求 | 推荐 | 说明 |
|---|---|---|
| 信号 → context | `os/signal.NotifyContext` | Go 1.16+，标准库 |
| HTTP 优雅关闭 | `http.Server.Shutdown(ctx)` | 核心；所有实现 `http.Handler` 的框架都适用 |
| 多 goroutine 编排 | `golang.org/x/sync/errgroup` | `WithContext`、`SetLimit`；错误传播 |
| 组件生命周期（可选） | `github.com/oklog/run` | 轻量 actor group，仍在维护；与 errgroup 二选一即可 |
| 依赖注入生命周期 | `go.uber.org/fx` | 已有 fx 时用 `Lifecycle.OnStop`，注意给 stop 设超时 |
| gRPC | `google.golang.org/grpc` 的 `GracefulStop` | 配 health 服务 + 超时 `Stop` |
| Web 框架（Gin） | `http.Server{Handler: ginEngine}` | Gin 本身不提供 Shutdown；`gin-contrib/graceful` 可选但非必需 |
| Web 框架（Echo） | `echo.Shutdown(ctx)` | 原生支持 |
| Web 框架（Fiber） | `app.Shutdown()` / `ShutdownWithTimeout()` | 基于 fasthttp，流式/劫持连接需单独测试 |
| Web 框架（Chi） | `http.Server.Shutdown` | Chi 是 `http.Handler` |
| PostgreSQL | `pgxpool.Pool.Close()` / `database/sql.DB.Close()` | 先取消查询 context，再关闭 |
| Redis | `go-redis` 的 `Client.Close()` | 先确保在途命令完成 |
| MongoDB | `mongo.Client.Disconnect(ctx)` | 传超时 context |
| Kafka | `segmentio/kafka-go`、`IBM/sarama` | producer flush、consumer commit + leave group |
| NATS | `nats.Conn.Drain()` | 比 `Close()` 更优雅 |
| RabbitMQ | `rabbitmq/amqp091-go` | 等 publisher confirm、处理未 ack 消息 |
| OpenTelemetry | `TracerProvider.Shutdown(ctx)`、`MeterProvider.Shutdown(ctx)` | 最后 flush |
| 零停机二进制升级（非 K8s） | `cloudflare/tableflip` | 通过 socket 继承；K8s 用滚动更新即可，不需要 |

### 9.3 不推荐 / 慎用

| 库 | 状态 | 原因 |
|---|---|---|
| `tylerb/graceful` | 已归档（2018） | 功能被 `http.Server.Shutdown` 覆盖 |
| `facebookgo/grace` | 已归档（2019） | 同上；不要在新项目使用 |
| 自写 `signal.Notify` 包一层 | — | 容易漏掉 `Stop`、第二次信号、超时 |
| 在库内部偷偷注册信号 | — | 与调用方的关闭流程冲突；库应接收 context，不应接管信号 |

### 9.4 选型决策

```
只用标准库够吗？
├─ HTTP → 是：http.Server.Shutdown
├─ gRPC → 是：GracefulStop + timeout
├─ 多组件 → 加 x/sync/errgroup
├─ 已有 fx → 用 fx.Lifecycle
└─ 需要 socket 继承/零停机升级（非 K8s）→ tableflip
```

---

## 10. 测试与验收

### 10.1 本地测试

1. 启动二进制，等 `/healthz` 返回 200。
2. 发起一个慢请求（handler sleep 3s）。
3. 发送 `SIGTERM`。
4. 断言：
   - 慢请求最终返回 200，而不是连接重置；
   - 排空期间新请求得到 503 或连接拒绝；
   - 进程在宽限期内以 0 退出；
   - 日志显示 shutdown 完成。

```go
cmd := exec.Command("./app")
cmd.Start()

// 等 ready
waitForReady("http://127.0.0.1:8080/healthz")

slow := make(chan error, 1)
go func() {
	resp, err := http.Get("http://127.0.0.1:8080/slow")
	if err == nil {
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			err = fmt.Errorf("status %d", resp.StatusCode)
		}
	}
	slow <- err
}()

time.Sleep(200 * time.Millisecond)
_ = cmd.Process.Signal(syscall.SIGTERM)

if err := <-slow; err != nil {
	t.Fatalf("in-flight request failed: %v", err)
}
if err := cmd.Wait(); err != nil {
	t.Fatalf("process exit: %v", err)
}
```

### 10.2 K8s 验收

```bash
# 观察 EndpointSlice 变化
kubectl get endpointslice -w

# 观察 Pod 终止
kubectl get pods -w

# 滚动发布期间持续压测，观察 5xx
hey -z 60s -c 20 http://app.default.svc.cluster.local/

# 主动删除一个 Pod
kubectl delete pod app-xxxxx --grace-period=30
```

验收标准：

- 发布/删除期间，客户端 5xx 与连接错误接近 0；
- Pod 在 `terminationGracePeriodSeconds` 内退出；
- 没有 `SIGKILL` 日志；
- 队列无重复消费/消息丢失（按业务语义）；
- 数据库无未提交事务/连接泄漏。

### 10.3 故障注入

- 在 handler 中注入 10s 延迟，确认 `shutdownTimeout` 与宽限期足够；
- 停掉外部 LB 的健康检查，确认 preStop/drain 仍能覆盖；
- 模拟 DB 慢查询，确认取消 context 后 `DB.Close()` 不阻塞；
- 模拟 gRPC 长流，确认 `GracefulStop` 超时后 `Stop()` 生效。

---

## 11. 检查清单

### 代码

- [ ] 监听 `SIGTERM` 和 `SIGINT`，使用 `signal.NotifyContext`。
- [ ] 收到信号后先 `readiness = false`，再延迟，再 `Shutdown`。
- [ ] `Shutdown` 使用带超时的 context；检查返回 error。
- [ ] 超时后 `Close()` + 短等待；不无限阻塞。
- [ ] `ListenAndServe` 忽略 `http.ErrServerClosed`。
- [ ] handler 使用 `r.Context()`，DB/HTTP 调用带 context。
- [ ] 没有不可取消的 `time.Sleep`。
- [ ] 后台 goroutine 用 errgroup/WaitGroup 跟踪。
- [ ] 资源按逆序关闭；DB 在 HTTP 之后关闭。
- [ ] 关闭路径没有 `os.Exit`/`log.Fatal`。
- [ ] WebSocket/hijacked 连接主动关闭。
- [ ] gRPC 使用 `GracefulStop` + 超时 `Stop`。
- [ ] 队列消费者先停拉取、再等处理、最后 commit/close。
- [ ] telemetry/日志最后 flush。

### Kubernetes

- [ ] `terminationGracePeriodSeconds` 覆盖 preStop + drain + shutdown + 余量。
- [ ] readiness 与 liveness 分离；排空时 readiness 503、liveness 200。
- [ ] 有 preStop 或代码内 drain delay，覆盖 LB 传播。
- [ ] 容器使用 exec form，SIGTERM 能到达 PID 1。
- [ ] `maxUnavailable: 0` / 足够副本，滚动更新不降容量。
- [ ] 有 PDB，节点 drain 不一次性带走所有副本。
- [ ] 外部 LB 的健康检查周期已知，并纳入预算。

---

## 12. 与原文的差异与补充

| 主题 | 原文 | 本文补充 |
|---|---|---|
| 信号 | `signal.Notify` + 缓冲 1；`NotifyContext` | 强调 `stop()` 恢复默认行为、第二次信号强制退出、PID 1/shell 转发 |
| 超时 | 默认 30s，建议留 20% 余量 | 给出预算公式和分阶段示例 |
| 摘流量 | preStop sleep 或 readiness 失败 + 延迟 | 补充 preStop 调 drain 端点的组合方案，以及外部 LB 差异 |
| 在途请求 | `Shutdown(ctx)` + `BaseContext`/中间件 | 补充 `Shutdown` 不等待 hijacked 连接、SSE/WebSocket 处理 |
| 资源释放 | 逆序关闭、defer | 补充 `DB.Close()` 可能阻塞、取消 context 的顺序 |
| gRPC/队列 | 未展开 | 增加 `GracefulStop` 超时、Kafka/NATS/Sarama 关闭顺序 |
| 测试 | 未展开 | 增加本地 SIGTERM 测试与 K8s 验收命令 |

原文中的两处小问题：

1. 示例在 `ListenAndServe` 的 goroutine 里 `panic(err)`，会跳过 `defer`；本文改为通过 `errCh` 返回错误，由 `run()` 统一清理。
2. 示例在 `Shutdown` 返回 error 后只 `sleep`，没有 `Close()`；本文补上 `Close()`，避免残留连接拖到 SIGKILL。

---

## 13. 参考

- VictoriaMetrics: *Graceful Shutdown in Go: Practical Patterns*  
  https://victoriametrics.com/blog/go-graceful-shutdown/index.html
- Go `net/http` Server.Shutdown  
  https://pkg.go.dev/net/http#Server.Shutdown
- Go `os/signal` NotifyContext  
  https://pkg.go.dev/os/signal#NotifyContext
- Kubernetes Pod Lifecycle / Termination  
  https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/
- Kubernetes Container Lifecycle Hooks  
  https://kubernetes.io/docs/concepts/containers/container-lifecycle-hooks/
- Go `database/sql` DB.Close  
  https://pkg.go.dev/database/sql#DB.Close
- gRPC Go GracefulStop  
  https://pkg.go.dev/google.golang.org/grpc#Server.GracefulStop
