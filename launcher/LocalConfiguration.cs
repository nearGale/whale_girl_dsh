using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace WhaleLauncher
{
    internal sealed class LocalConfiguration
    {
        private readonly string _root;
        private readonly SemaphoreSlim _gate = new SemaphoreSlim(1, 1);
        private JsonElement _snapshot;
        private DateTime _loadedAt;

        public LocalConfiguration(string root) { _root = root; }

        public async Task<ApiResult> ReadAsync(string path)
        {
            await _gate.WaitAsync();
            try
            {
                if (_snapshot.ValueKind != JsonValueKind.Object || DateTime.UtcNow - _loadedAt > TimeSpan.FromSeconds(2))
                {
                    var text = await RunNodeAsync(
                        Path.Combine(_root, "src", "services", "launcherSnapshot.js"),
                        stdin: null,
                        timeoutSec: 8);
                    using var doc = JsonDocument.Parse(text);
                    _snapshot = doc.RootElement.Clone();
                    _loadedAt = DateTime.UtcNow;
                }
                if (!_snapshot.TryGetProperty(path, out var payload))
                    return new ApiResult { Ok = false, Error = "此功能需要启动内核。" };
                return new ApiResult { Ok = true, StatusCode = 200, Root = payload.Clone() };
            }
            catch
            {
                return new ApiResult { Ok = false, Error = "读取本地配置失败，请检查配置文件和 Node 运行环境。" };
            }
            finally { _gate.Release(); }
        }

        /// <summary>
        /// 未起内核时走短进程写入；请求/响应形状尽量贴近 HTTP API，方便页面共用。
        /// </summary>
        public async Task<ApiResult> WriteAsync(string path, string jsonBody)
        {
            await _gate.WaitAsync();
            try
            {
                JsonElement bodyEl = default;
                if (!string.IsNullOrWhiteSpace(jsonBody))
                {
                    using var bodyDoc = JsonDocument.Parse(jsonBody);
                    bodyEl = bodyDoc.RootElement.Clone();
                }
                using var req = new MemoryStream();
                using (var writer = new Utf8JsonWriter(req))
                {
                    writer.WriteStartObject();
                    writer.WriteString("path", path);
                    writer.WritePropertyName("body");
                    if (bodyEl.ValueKind is JsonValueKind.Object or JsonValueKind.Array)
                        bodyEl.WriteTo(writer);
                    else
                        writer.WriteStartObject(); writer.WriteEndObject();
                    writer.WriteEndObject();
                }
                var text = await RunNodeAsync(
                    Path.Combine(_root, "src", "services", "launcherOfflineWrite.js"),
                    stdin: Encoding.UTF8.GetString(req.ToArray()),
                    timeoutSec: 20);
                // 写完就作废缓存，下次读一定重新拉盘
                _snapshot = default;
                _loadedAt = DateTime.MinValue;

                using var doc = JsonDocument.Parse(text);
                var root = doc.RootElement;
                var ok = root.ValueKind == JsonValueKind.Object
                    && root.TryGetProperty("ok", out var okEl)
                    && okEl.ValueKind == JsonValueKind.True;
                var error = "";
                if (root.ValueKind == JsonValueKind.Object
                    && root.TryGetProperty("error", out var er)
                    && er.ValueKind == JsonValueKind.String)
                    error = er.GetString() ?? "";

                // 把单次 op 的 result 抬到顶层，页面仍按 /api/* 响应读字段
                JsonElement payload = root.Clone();
                if (root.ValueKind == JsonValueKind.Object
                    && root.TryGetProperty("results", out var results)
                    && results.ValueKind == JsonValueKind.Array
                    && results.GetArrayLength() > 0)
                {
                    var last = results[results.GetArrayLength() - 1];
                    if (last.ValueKind == JsonValueKind.Object && last.TryGetProperty("result", out var result))
                    {
                        payload = result.Clone();
                        if (payload.ValueKind == JsonValueKind.Object
                            && payload.TryGetProperty("ok", out var rok)
                            && rok.ValueKind == JsonValueKind.False)
                            ok = false;
                        if (error.Length == 0
                            && payload.ValueKind == JsonValueKind.Object
                            && payload.TryGetProperty("error", out var per)
                            && per.ValueKind == JsonValueKind.String)
                            error = per.GetString() ?? "";
                    }
                }

                return new ApiResult
                {
                    Ok = ok,
                    StatusCode = ok ? 200 : 400,
                    Error = error,
                    Raw = text,
                    Root = payload,
                };
            }
            catch
            {
                return new ApiResult { Ok = false, Error = "写入本地配置失败，请检查配置文件和 Node 运行环境。" };
            }
            finally { _gate.Release(); }
        }

        private async Task<string> RunNodeAsync(string script, string stdin, int timeoutSec)
        {
            var node = Path.Combine(_root, "runtime", "node.exe");
            var info = new ProcessStartInfo
            {
                FileName = File.Exists(node) ? node : "node",
                WorkingDirectory = _root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                RedirectStandardInput = stdin != null,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            info.ArgumentList.Add(script);
            using var process = Process.Start(info)
                ?? throw new IOException("无法启动 Node 读取/写入本地配置。");
            if (stdin != null)
            {
                await process.StandardInput.WriteAsync(stdin);
                process.StandardInput.Close();
            }
            var stdout = process.StandardOutput.ReadToEndAsync();
            var stderr = process.StandardError.ReadToEndAsync();
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(timeoutSec));
            try { await process.WaitForExitAsync(deadline.Token); }
            catch (OperationCanceledException)
            {
                try { process.Kill(true); } catch { }
                throw;
            }
            var text = await stdout;
            var err = await stderr;
            if (process.ExitCode != 0 && string.IsNullOrWhiteSpace(text))
                throw new IOException(string.IsNullOrWhiteSpace(err)
                    ? "无法读写本地配置，请检查配置文件格式与目录权限。"
                    : err.Trim());
            if (string.IsNullOrWhiteSpace(text))
                throw new IOException("本地配置进程没有返回内容。");
            return text;
        }
    }
}
