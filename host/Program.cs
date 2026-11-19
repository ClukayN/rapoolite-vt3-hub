// RapooLite 原生宿主：无边框窗口 + WebView2 界面 + 系统托盘 + 后端进程管理
// 编译：csc /target:winexe /out:..\dist\RapooLite.exe /r:lib\*.dll Program.cs

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace RapooLite
{
    internal static class Program
    {
        private static void Trace(string msg)
        {
            try
            {
                File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "rapoolite-trace.log"),
                    DateTime.Now.ToString("HH:mm:ss.fff ") + msg + Environment.NewLine, Encoding.UTF8);
            }
            catch
            {
            }
        }

        private static Mutex singleInstance;

        /// <summary>诊断用：把几种电量的托盘图标拼成一张预览图。</summary>
        private static int IconPreview()
        {
            var samples = new[] { 100, 86, 60, 50, 35, 20, 8, -1 };
            const int cell = 64;
            var gap = 12;
            using (var bmp = new Bitmap(samples.Length * (cell + gap) + gap, cell + gap * 2))
            using (var g = Graphics.FromImage(bmp))
            {
                g.Clear(Color.FromArgb(24, 26, 32));
                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.NearestNeighbor;
                g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.Half;
                for (var i = 0; i < samples.Length; i++)
                {
                    using (var b = TrayIcons.BuildBitmap(samples[i], samples[i] >= 0))
                    {
                        g.DrawImage(b, new Rectangle(gap + i * (cell + gap), gap, cell, cell));
                    }
                }
                var path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "icon-preview.png");
                bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);
                Trace("icon preview written: " + path);
            }
            return 0;
        }

        private static int TrayProbe()
        {
            var log = Path.Combine(AppDomain.CurrentDomain.BaseDirectory,
                "probe-" + Path.GetFileName(Application.ExecutablePath) + ".log");
            var tray = new NotifyIcon
            {
                Icon = TrayIcons.Build(80, true),
                Text = "RapooLite · VT3",
                Visible = true,
            };
            AppendLog(log, string.Format(
                "probe: visible={0} icon={1}x{2} handleZero={3} textLen={4}",
                tray.Visible, tray.Icon.Width, tray.Icon.Height, tray.Icon.Handle == IntPtr.Zero, tray.Text.Length));

            var form = new Form { ShowInTaskbar = false, WindowState = FormWindowState.Minimized };
            var t = new System.Windows.Forms.Timer { Interval = 8000 };
            t.Tick += (s, e) =>
            {
                t.Stop();
                AppendLog(log, "probe result: " + TrayIcons.ShellRegistered(Application.ExecutablePath));
                tray.Visible = false;
                Application.Exit();
            };
            t.Start();
            Application.Run(form);
            return 0;
        }

        private static void AppendLog(string path, string text)
        {
            try
            {
                File.AppendAllText(path, DateTime.Now.ToString("HH:mm:ss") + " " + text + "\r\n");
            }
            catch
            {
                // ignore
            }
        }

        [STAThread]
        private static int Main(string[] args)
        {
            var crash = Path.Combine(Path.GetTempPath(), "rapoolite-crash.log");
            Trace("main entry");
            Native.EnablePerMonitorDpi();
            try
            {
                ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Trace("visual styles ok");
                var silent = Array.IndexOf(args, "--silent") >= 0;

                // 卸载器：由主程序复制到 %TEMP% 后以 --uninstall-run <productCode> <installDir> 调用
                if (args.Length >= 3 && args[0] == "--uninstall-run")
                {
                    return Uninstaller.Run(args[1], args[2]);
                }

                // 诊断用：把几种电量的托盘图标拼成一张预览图
                if (Array.IndexOf(args, "--icon-preview") >= 0)
                {
                    return IconPreview();
                }

                if (Array.IndexOf(args, "--tray-probe") >= 0)
                {
                    return TrayProbe();
                }

                // 单实例：用命名互斥体判断，再用广播消息把已有窗口叫到前台（不依赖窗口标题，避免编译后标题变动失效）
                if (Array.IndexOf(args, "--selftest") < 0)
                {
                    bool isNew;
                    singleInstance = new Mutex(true, @"Local\RapooLite.SingleInstance", out isNew);
                    if (!isNew)
                    {
                        var msg = Native.RegisterWindowMessage(Native.SHOW_MESSAGE);
                        if (msg != 0)
                        {
                            Native.PostMessage(Native.HWND_BROADCAST, msg, IntPtr.Zero, IntPtr.Zero);
                        }
                        Trace("another instance is running, asked it to show its window");
                        Thread.Sleep(400);
                        return 0;
                    }
                }

                var app = new App(silent, args);
                Trace("app created");
                if (Array.IndexOf(args, "--diagnose") >= 0)
                {
                    app.Diagnose();
                    return 0;
                }
                app.Start();
                Trace("start returned");
                return 0;
            }
            catch (Exception ex)
            {
                Trace("crash: " + ex);
                try
                {
                    File.WriteAllText(crash, DateTime.Now + Environment.NewLine + ex, Encoding.UTF8);
                }
                catch
                {
                }
                Console.Error.WriteLine("RapooLite 启动失败：" + ex);
                return 1;
            }
        }
    }

    internal sealed class App
    {
        private const int BasePort = 7373;
        private const int PortSpan = 30;

        private readonly bool silent;
        private readonly string[] args;
        private readonly string appDir;
        private readonly HttpClient http = new HttpClient();
        private readonly string logPath;

        private int port;
        private Process server;
        private bool ownsServer;

        private ShellForm form;
        private WebView2 web;
        private NotifyIcon tray;
        private ToolStripMenuItem autostartItem;
        private System.Windows.Forms.Timer trayTimer;
        private string lastTip = "";
        private string trayIconKey = "";
        private int lastBattery = -1;
        private bool lastConnected;
        private System.Windows.Forms.Timer trayWatchdog;
        private System.Windows.Forms.Timer iconReaper;
        private readonly List<KeyValuePair<DateTime, Icon>> retiredIcons = new List<KeyValuePair<DateTime, Icon>>();
        private OsdForm osd;
        private int lastDpiIndex = -1;
        private volatile bool closing;
        private volatile bool baselineReady;

        public App(bool silent, string[] args)
        {
            this.silent = silent;
            this.args = args;
            appDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            var dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RapooLite");
            try { Directory.CreateDirectory(dataDir); } catch { }
            logPath = Path.Combine(appDir, "host.log");
            try { File.AppendAllText(logPath, ""); } catch { logPath = Path.Combine(Path.GetTempPath(), "rapoolite-host.log"); }
            http.Timeout = TimeSpan.FromSeconds(6);
        }

        public void Start()
        {
            Application.ThreadException += (s, e) => Log("UI 异常：" + e.Exception);
            AppDomain.CurrentDomain.UnhandledException += (s, e) => Log("致命异常：" + e.ExceptionObject);

            Log("启动，目录 " + appDir);
            if (!ResolveBackend())
            {
                Log("后端启动失败，退出");
                MessageBox.Show("RapooLite 后端启动失败。\n请确认 node.exe 可用，详见日志：\n" + logPath,
                    "RapooLite", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            BuildWindow();
            Log("窗口已创建 handle=" + form.Handle);
            BuildTray();
            Log("托盘已创建");
            StartEventStream();
            if (Array.IndexOf(args, "--osd-demo") >= 0)
            {
                Log("档位提示演示模式");
                var demo = new System.Windows.Forms.Timer { Interval = 900 };
                demo.Tick += (s, e) => ShowOsd(3200, 2, 4);
                demo.Start();
            }
            InitWebView();
            if (!silent) ShowWindow();
            Log("进入消息循环");
            // Application.Run(form) 会强制显示窗口；静默启动时用空上下文承载消息循环，
            // 窗口保持隐藏，等托盘左键 -> ShowWindow。
            if (silent) Application.Run(new SilentContext(form));
            else Application.Run(form);
            Log("消息循环结束");
        }

        /// <summary>只做启动检查并打印结果，用于排障。</summary>
        public void Diagnose()
        {
            Console.WriteLine("appDir = " + appDir);
            Console.WriteLine("logPath = " + logPath);
            Console.WriteLine("node = " + (FindNode() ?? "(未找到)"));
            Console.WriteLine("server.js = " + (FindServerScript() ?? "(未找到)"));
            var ok = ResolveBackend();
            Console.WriteLine("backend = " + (ok ? "ok, port " + port : "失败"));
            if (ok)
            {
                Console.WriteLine("state = " + GetSync("http://127.0.0.1:" + port + "/api/state"));
            }
        }

        // ---------------- 后端 ----------------

        private bool ResolveBackend()
        {
            // 先用「端口能不能 bind」判断有没有人在听：比逐个 ping 快得多
            var free = -1;
            for (var p = BasePort; p < BasePort + PortSpan; p++)
            {
                if (PortFree(p))
                {
                    if (free < 0) free = p;
                    continue;
                }
                var ping = GetSync("http://127.0.0.1:" + p + "/api/ping");
                if (ping != null && ping.Contains("\"RapooLite\""))
                {
                    port = p;
                    ownsServer = false;
                    Log("复用已有后端，端口 " + p);
                    return true;
                }
            }

            var script = FindServerScript();
            if (script == null)
            {
                Log("找不到 server.js");
                return false;
            }

            var node = FindNode();
            if (node == null)
            {
                Log("找不到 node.exe");
                return false;
            }

            if (free > 0 && StartServer(node, script, free)) return true;
            for (var p = BasePort; p < BasePort + PortSpan; p++)
            {
                if (PortFree(p) && StartServer(node, script, p)) return true;
            }
            return false;
        }

        private string FindServerScript()
        {
            string[] candidates =
            {
                Path.Combine(appDir, @"app\server.js"),
                Path.Combine(appDir, "server.js"),
                Path.Combine(Path.GetDirectoryName(appDir), "server.js"),
            };
            foreach (var c in candidates)
            {
                if (c != null && File.Exists(c)) return Path.GetFullPath(c);
            }
            return null;
        }

        private string FindNode()
        {
            var local = Path.Combine(appDir, "node.exe");
            if (File.Exists(local)) return local;

            var buf = new StringBuilder(1024);
            if (SearchPath(null, "node.exe", null, buf.Capacity, buf, IntPtr.Zero) > 0 && File.Exists(buf.ToString()))
                return buf.ToString();

            string[] guesses =
            {
                @"D:\nodejs\node.exe",
                @"C:\Program Files\nodejs\node.exe",
                @"C:\Program Files (x86)\nodejs\node.exe",
            };
            foreach (var g in guesses)
            {
                if (File.Exists(g)) return g;
            }
            return null;
        }

        private bool StartServer(string node, string script, int candidatePort)
        {
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = node,
                    Arguments = "\"" + script + "\" --port " + candidatePort,
                    WorkingDirectory = Path.GetDirectoryName(script),
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                psi.EnvironmentVariables["RAPOOLITE_HOST_EXE"] = Application.ExecutablePath;
                psi.EnvironmentVariables["RAPOOLITE_PORT"] = candidatePort.ToString();
                // 主题与背景图存在 exe 旁边，重打包 app\ 时不会丢
                psi.EnvironmentVariables["RAPOOLITE_DATA_DIR"] = Path.Combine(appDir, "data");

                var proc = Process.Start(psi);
                if (proc == null) return false;

                var logFile = Path.Combine(Path.GetDirectoryName(logPath), "server.log");
                proc.OutputDataReceived += (s, e) => AppendServerLog(logFile, e.Data);
                proc.ErrorDataReceived += (s, e) => AppendServerLog(logFile, e.Data);
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();

                var deadline = DateTime.UtcNow.AddSeconds(20);
                while (DateTime.UtcNow < deadline)
                {
                    if (proc.HasExited)
                    {
                        Log("后端进程提前退出，code=" + proc.ExitCode);
                        break;
                    }
                    var ping = GetSync("http://127.0.0.1:" + candidatePort + "/api/ping");
                    if (ping != null && ping.Contains("\"RapooLite\""))
                    {
                        port = candidatePort;
                        server = proc;
                        ownsServer = true;
                        Log("后端就绪，端口 " + candidatePort);
                        return true;
                    }
                    System.Threading.Thread.Sleep(220);
                }
                try
                {
                    if (!proc.HasExited) proc.Kill();
                }
                catch
                {
                }
                return false;
            }
            catch (Exception ex)
            {
                Log("启动后端异常：" + ex.Message);
                return false;
            }
        }

        private static void AppendServerLog(string file, string line)
        {
            if (string.IsNullOrEmpty(line)) return;
            try
            {
                File.AppendAllText(file, line + Environment.NewLine, Encoding.UTF8);
            }
            catch
            {
            }
        }

        private static bool PortFree(int p)
        {
            try
            {
                var l = new System.Net.Sockets.TcpListener(IPAddress.Loopback, p);
                l.Start();
                l.Stop();
                return true;
            }
            catch
            {
                return false;
            }
        }

        // ---------------- 窗口 ----------------

        private void BuildWindow()
        {
            // 高 DPI：窗口尺寸在句柄创建后按该显示器的真实 DPI 换算（200% 时用物理像素铺开才清晰）
            form = new ShellForm();
            form.Text = "RapooLite · VT3";
            form.FormBorderStyle = FormBorderStyle.None;
            form.StartPosition = FormStartPosition.CenterScreen;
            form.BackColor = Color.FromArgb(10, 11, 13);
            form.KeyPreview = true;
            form.Icon = LoadAppIcon();
            form.FormClosing += OnFormClosing;
            form.KeyDown += (s, e) =>
            {
                if (e.KeyCode == Keys.F5 && web != null)
                {
                    web.CoreWebView2.Reload();
                    e.Handled = true;
                }
            };
        }

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            if (e.CloseReason == CloseReason.UserClosing && tray != null)
            {
                e.Cancel = true;
                form.Hide();
            }
        }

        private void ShowWindow()
        {
            form.Show();
            if (form.WindowState == FormWindowState.Minimized) form.WindowState = FormWindowState.Normal;
            form.RefreshDpiLayout();
            form.Activate();
            form.BringToFront();
        }

        private static Icon LoadAppIcon()
        {
            try
            {
                var ico = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (ico != null) return ico;
            }
            catch
            {
            }
            return TrayIcons.Build(100, true);
        }

        private async void InitWebView()
        {
            try
            {
                // WebView2 的缓存目录放在程序旁边：可移植，且不依赖 AppData 的写入权限
                var userData = Path.Combine(appDir, "userdata");
                try
                {
                    Directory.CreateDirectory(userData);
                }
                catch
                {
                    userData = Path.Combine(Path.GetTempPath(), "RapooLite-WebView2");
                    Directory.CreateDirectory(userData);
                }

                Log("准备创建 WebView2 环境");
                var env = await CoreWebView2Environment.CreateAsync(null, userData);
                Log("环境就绪");
                web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(10, 11, 13) };
                form.Controls.Add(web);
                await web.EnsureCoreWebView2Async(env);

                var core = web.CoreWebView2;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.AreDevToolsEnabled = true;
                core.Settings.IsZoomControlEnabled = false;
                core.Settings.AreBrowserAcceleratorKeysEnabled = false;
                core.WebMessageReceived += OnWebMessage;

                Log("WebView2 就绪，开始导航");
                core.NavigationCompleted += async (s, e) => await SelfTestAsync(e.IsSuccess);
                core.Navigate("http://127.0.0.1:" + port + "/");
                Log("界面加载 http://127.0.0.1:" + port + "/");
            }
            catch (Exception ex)
            {
                Log("WebView2 初始化失败：" + ex);
                if (!silent)
                {
                    MessageBox.Show("界面初始化失败：\n" + ex.Message + "\n\n请确认已安装 WebView2 运行时。",
                        "RapooLite", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
        }

        private async Task SelfTestAsync(bool ok)
        {
            if (Array.IndexOf(args, "--selftest") < 0) return;
            Log("自检：页面加载 " + (ok ? "成功" : "失败"));
            try
            {
                var title = await web.CoreWebView2.ExecuteScriptAsync("document.title + '|' + document.querySelectorAll('.tab-item').length");
                Log("自检：标题/标签数 = " + title);

                await web.CoreWebView2.ExecuteScriptAsync(
                    "window.chrome.webview.postMessage(JSON.stringify({type:'window',action:'maximize'}))");
                await Task.Delay(700);
                Log("自检：最大化后 WindowState = " + form.WindowState);

                await web.CoreWebView2.ExecuteScriptAsync(
                    "window.chrome.webview.postMessage(JSON.stringify({type:'window',action:'minimize'}))");
                await Task.Delay(700);
                Log("自检：最小化后 WindowState = " + form.WindowState);

                form.WindowState = FormWindowState.Normal;
                await web.CoreWebView2.ExecuteScriptAsync(
                    "window.chrome.webview.postMessage(JSON.stringify({type:'window',action:'close'}))");
                await Task.Delay(700);
                Log("自检：关闭后 Visible = " + form.Visible);
                Log("自检结束");
                Application.Exit();
            }
            catch (Exception ex)
            {
                Log("自检失败：" + ex.Message);
                Application.Exit();
            }
        }

        private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string raw;
            try
            {
                raw = e.TryGetWebMessageAsString();
            }
            catch
            {
                raw = e.WebMessageAsJson;
            }
            if (string.IsNullOrEmpty(raw)) return;

            Log("收到界面消息：" + raw);
            if (raw.Contains("\"action\":\"minimize\""))
            {
                form.WindowState = FormWindowState.Minimized;
            }
            else if (raw.Contains("\"action\":\"maximize\""))
            {
                form.WindowState = form.WindowState == FormWindowState.Maximized
                    ? FormWindowState.Normal
                    : FormWindowState.Maximized;
            }
            else if (raw.Contains("\"action\":\"close\""))
            {
                form.Hide();
            }
            else if (raw.Contains("\"action\":\"drag\""))
            {
                Native.ReleaseCapture();
                Native.SendMessage(form.Handle, Native.WM_NCLBUTTONDOWN, (IntPtr)Native.HTCAPTION, IntPtr.Zero);
            }
            else if (raw.Contains("\"action\":\"uninstall\""))
            {
                UninstallApp();
            }
        }

        // ---------------- 卸载 ----------------

        /// <summary>从注册表里找出本产品的 MSI ProductCode。</summary>
        private static string FindProductCode()
        {
            var roots = new[]
            {
                @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
                @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
            };
            foreach (var root in roots)
            {
                try
                {
                    using (var key = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(root))
                    {
                        if (key == null) continue;
                        foreach (var name in key.GetSubKeyNames())
                        {
                            if (!name.StartsWith("{")) continue;
                            try
                            {
                                using (var sub = key.OpenSubKey(name))
                                {
                                    if (sub == null) continue;
                                    var display = sub.GetValue("DisplayName") as string;
                                    if (!string.IsNullOrEmpty(display) && display.StartsWith("RapooLite"))
                                        return name;
                                }
                            }
                            catch { }
                        }
                    }
                }
                catch { }
            }
            return null;
        }

        /// <summary>把自身复制到临时目录，由那份副本等主进程退出后执行 msiexec 卸载并清理残留。</summary>
        private static bool StartDetachedUninstaller(string productCode)
        {
            try
            {
                var dir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
                var temp = Path.Combine(Path.GetTempPath(), "RapooLite-uninstall-" + Guid.NewGuid().ToString("N").Substring(0, 6) + ".exe");
                File.Copy(Application.ExecutablePath, temp, true);
                var psi = new ProcessStartInfo(temp, "--uninstall-run " + productCode + " \"" + dir + "\"")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                };
                Process.Start(psi);
                return true;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Trace.WriteLine("start uninstaller failed: " + ex.Message);
                return false;
            }
        }

        // ---------------- 托盘 ----------------

        private void BuildTray()
        {
            tray = new NotifyIcon
            {
                Icon = TrayIcons.Build(-1, false),
                Text = "RapooLite · VT3",
                Visible = true,
            };
            try
            {
                Log(string.Format(
                    "托盘注册：visible={0} icon={1}x{2} handleZero={3}",
                    tray.Visible, tray.Icon.Width, tray.Icon.Height, tray.Icon.Handle == IntPtr.Zero));
            }
            catch (Exception ex)
            {
                Log("托盘注册检查失败：" + ex.Message);
            }

            var menu = new ContextMenuStrip();
            var open = new ToolStripMenuItem("打开界面", null, (s, e) => ShowWindow()) { Font = new Font("Segoe UI", 9f, FontStyle.Bold) };
            var refresh = new ToolStripMenuItem("重新读取", null, (s, e) => RefreshDevice());
                    autostartItem = new ToolStripMenuItem("开机自启", null, (s, e) => ToggleAutostart()) { CheckOnClick = false };
            var quit = new ToolStripMenuItem("退出", null, (s, e) => Quit());
            var uninstallItem = new ToolStripMenuItem("卸载 RapooLite…", null, (s, e) => UninstallApp());
            menu.Items.Add(open);
            menu.Items.Add(refresh);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(autostartItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(uninstallItem);
            menu.Items.Add(quit);
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += (s, e) => ShowWindow();

            trayTimer = new System.Windows.Forms.Timer { Interval = 5000 };
            trayTimer.Tick += async (s, e) => await PollState();
            trayTimer.Start();
            Task.Run(async () => await PollState());

            var trayCheck = new System.Windows.Forms.Timer { Interval = 6000 };
            trayCheck.Tick += (s, e) =>
            {
                trayCheck.Stop();
                trayCheck.Dispose();
                Log("托盘自检：" + TrayIcons.ShellRegistered(Application.ExecutablePath));
            };
            trayCheck.Start();

            // 看门狗：外壳偶尔会把托盘图标丢掉（资源管理器重启、休眠恢复、图标句柄被回收），
            // 每 45 秒确认一次，发现没登记就重建一次 NotifyIcon。
            var watch = new System.Windows.Forms.Timer { Interval = 45000 };
            watch.Tick += (s, e) =>
            {
                try
                {
                    if (tray == null || closing) return;
                    var state = TrayIcons.ShellRegistered(Application.ExecutablePath);
                    if (state.StartsWith("registered", StringComparison.Ordinal)) return;
                    Log("托盘图标丢失，重新注册：" + state);
                    RebuildTrayIcon();
                }
                catch (Exception ex)
                {
                    Log("托盘 watchdog 异常：" + ex.Message);
                }
            };
            watch.Start();
            trayWatchdog = watch;
        }

        /// <summary>轻量重建：先摘掉再挂上，保留菜单与事件。</summary>
        private void RebuildTrayIcon()
        {
            if (tray == null) return;
            try
            {
                tray.Visible = false;
                var icon = TrayIcons.Build(lastBattery, lastConnected);
                var old = tray.Icon;
                tray.Icon = icon;
                tray.Visible = true;
                trayIconKey = lastConnected ? "on:" + lastBattery : "off";
                if (old != null) RetireIcon(old);
            }
            catch (Exception ex)
            {
                Log("托盘重建失败：" + ex.Message);
            }
        }

        // ---------------- 档位变化提示（SSE） ----------------

        private void StartEventStream()
        {
            var th = new Thread(EventLoop) { IsBackground = true, Name = "rapoolite-sse" };
            th.Start();
        }

        private void EventLoop()
        {
            while (!closing)
            {
                try
                {
                    var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/events");
                    req.Timeout = 30000;
                    req.ReadWriteTimeout = 120000;
                    req.KeepAlive = true;
                    req.Proxy = null;
                    req.Accept = "text/event-stream";
                    using (var res = (HttpWebResponse)req.GetResponse())
                    using (var reader = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                    {
                        Log("状态流已连接");
                        string line;
                        while (!closing && (line = reader.ReadLine()) != null)
                        {
                            if (!line.StartsWith("data:", StringComparison.Ordinal)) continue;
                            var payload = line.Substring(5).Trim();
                            if (payload.IndexOf("\"state\"", StringComparison.Ordinal) >= 0)
                            {
                                try { OnStateEvent(payload); }
                                catch (Exception ex) { Log("解析状态事件失败：" + ex.Message); }
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    Log("状态流中断：" + ex.Message);
                }
                if (closing) return;
                Thread.Sleep(1500);
            }
        }

        private void OnStateEvent(string json)
        {
            var idx = Match(json, "\"dpiIndex\":(\\d+)", lastDpiIndex < 0 ? 0 : lastDpiIndex);
            if (lastDpiIndex < 0 || !baselineReady)
            {
                // 首次事件只用来对齐基线，避免启动时误弹提示
                lastDpiIndex = idx;
                return;
            }
            if (idx == lastDpiIndex) return;
            lastDpiIndex = idx;

            var count = Match(json, "\"slotCount\":(\\d+)", 1);
            var dpi = 0;
            var m = Regex.Match(json, "\"dpiX\":\\[([0-9,]+)\\]");
            if (m.Success)
            {
                var parts = m.Groups[1].Value.Split(',');
                if (idx >= 0 && idx < parts.Length)
                {
                    int v;
                    if (int.TryParse(parts[idx], out v)) dpi = v;
                }
            }
            ShowOsd(dpi, idx, count);
        }

        private void ShowOsd(int dpi, int index, int count)
        {
            try
            {
                Log(string.Format("档位提示：第 {0} 档 {1}DPI", index + 1, dpi));
                if (form == null) return;
                if (osd == null || osd.IsDisposed) osd = new OsdForm();
                var handle = form.Handle; // 静默启动时窗口没显示过，这里确保句柄存在
                form.BeginInvoke(new Action(() => osd.Popup(dpi, index, count)));
            }
            catch (Exception ex)
            {
                Log("显示档位提示失败：" + ex.Message);
            }
        }

        private async Task PollState()
        {
            var json = await Get("/api/state");
            if (json == null)
            {
                SetTray(-1, false, "RapooLite · 后端未响应");
                return;
            }
            var battery = Match(json, "\"battery\":(-?\\d+)", -1);
            var connected = json.Contains("\"connected\":true");
            var dpi = Match(json, "\"dpiIndex\":(\\d+)", 0);
            var hz = Match(json, "\"pollingHz\":(\\d+)", 0);
            var dpiList = Regex.Match(json, "\"dpiX\":\\[(\\d+)");
            var cur = dpiList.Success ? Convert.ToInt32(dpiList.Groups[1].Value) : 0;
            if (lastDpiIndex < 0) lastDpiIndex = dpi;
            baselineReady = true;

            var tip = connected
                ? string.Format("RapooLite · VT3 · {0}% · {1}DPI {2}Hz", battery >= 0 ? battery : 0, cur, hz)
                : "RapooLite · 未连接";
            SetTray(battery, connected, tip);
            await RefreshAutostartState();
        }

        private void SetTray(int battery, bool connected, string tip)
        {
            if (tray == null) return;
            if (tip != lastTip)
            {
                tray.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;
                lastTip = tip;
            }

            // 图标里带电量数字，所以按「连接状态 + 电量值」作缓存键；旧图标延迟释放，避免销毁正在显示的 HICON
            lastBattery = battery;
            lastConnected = connected;
            var key = connected ? "on:" + battery : "off";
            if (key == trayIconKey) return;

            var icon = TrayIcons.Build(battery, connected);
            var old = tray.Icon;
            tray.Icon = icon;
            trayIconKey = key;
            if (old != null) RetireIcon(old);
        }

        /// <summary>旧图标延迟 60 秒再释放，避免外壳仍在引用时被销毁。</summary>
        private void RetireIcon(Icon icon)
        {
            retiredIcons.Add(new KeyValuePair<DateTime, Icon>(DateTime.UtcNow.AddSeconds(60), icon));
            if (iconReaper == null)
            {
                iconReaper = new System.Windows.Forms.Timer { Interval = 15000 };
                iconReaper.Tick += (s, e) =>
                {
                    var now = DateTime.UtcNow;
                    for (var i = retiredIcons.Count - 1; i >= 0; i--)
                    {
                        if (retiredIcons[i].Key > now) continue;
                        try
                        {
                            retiredIcons[i].Value.Dispose();
                        }
                        catch
                        {
                        }
                        retiredIcons.RemoveAt(i);
                    }
                };
                iconReaper.Start();
            }
        }

        private async Task RefreshAutostartState()
        {
            var json = await Get("/api/autostart");
            if (json == null || autostartItem == null) return;
            autostartItem.Checked = json.Contains("\"enabled\":true");
        }

        private async void ToggleAutostart()
        {
            var want = !(autostartItem.Checked);
            var payload = "{\"enabled\":" + (want ? "true" : "false") + "}";
            var json = await Post("/api/autostart", payload);
            if (json == null)
            {
                MessageBox.Show("设置开机自启失败。", "RapooLite", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            autostartItem.Checked = want;
        }

        private async void RefreshDevice()
        {
            var json = await Post("/api/refresh", "{}");
            if (json == null) MessageBox.Show("重新读取失败，请移动鼠标唤醒设备。", "RapooLite");
        }

        /// <summary>托盘菜单里的卸载：确认后交给 Windows Installer。</summary>
        private async void UninstallApp()
        {
            var answer = MessageBox.Show(
                "确定要卸载 RapooLite 吗？\r\n\r\n会移除程序本体、开始菜单快捷方式和开机自启。\r\n背景图与设置会保留在安装目录的 data 文件夹里。",
                "卸载 RapooLite",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning,
                MessageBoxDefaultButton.Button2);
            if (answer != DialogResult.Yes) return;

            var code = FindProductCode();
            if (string.IsNullOrEmpty(code))
            {
                MessageBox.Show(
                    "没有找到已安装的 MSI 记录。\r\n\r\n当前可能是免安装版本，直接删除安装目录即可。",
                    "RapooLite",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
                return;
            }

            if (!StartDetachedUninstaller(code))
            {
                MessageBox.Show("卸载失败：无法启动卸载程序。", "RapooLite", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            // 立刻退出，让临时副本能在文件解锁后调用 msiexec 并清理残留
            closing = true;
            if (tray != null) tray.Visible = false;
            if (ownsServer)
            {
                try { await Post("/api/quit", "{}"); } catch { }
                try
                {
                    if (server != null && !server.WaitForExit(1500)) server.Kill();
                }
                catch { }
            }
            Application.Exit();
            Environment.Exit(0);
        }

        private async void Quit()
        {
            closing = true;
            if (tray != null) tray.Visible = false;
            if (ownsServer)
            {
                await Post("/api/quit", "{}");
                try
                {
                    if (server != null && !server.WaitForExit(2500)) server.Kill();
                }
                catch
                {
                }
            }
            if (web != null)
            {
                try
                {
                    web.Dispose();
                }
                catch
                {
                }
            }
            Application.Exit();
        }

        // ---------------- HTTP 小工具 ----------------

        private async Task<string> Get(string path)
        {
            try
            {
                return await http.GetStringAsync("http://127.0.0.1:" + port + path);
            }
            catch (Exception ex)
            {
                Log("GET " + path + " 失败：" + ex.Message);
                return null;
            }
        }

        private async Task<string> Post(string path, string json)
        {
            try
            {
                var content = new StringContent(json, Encoding.UTF8, "application/json");
                var res = await http.PostAsync("http://127.0.0.1:" + port + path, content);
                return await res.Content.ReadAsStringAsync();
            }
            catch (Exception ex)
            {
                Log("POST " + path + " 失败：" + ex.Message);
                return null;
            }
        }

        private static string GetSync(string url)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = 900;
                req.Proxy = null;
                using (var res = (HttpWebResponse)req.GetResponse())
                using (var reader = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                {
                    return reader.ReadToEnd();
                }
            }
            catch
            {
                return null;
            }
        }

        private static int Match(string text, string pattern, int fallback)
        {
            var m = Regex.Match(text, pattern);
            if (!m.Success) return fallback;
            int v;
            return int.TryParse(m.Groups[1].Value, out v) ? v : fallback;
        }

        private void Log(string msg)
        {
            try
            {
                File.AppendAllText(logPath,
                    DateTime.Now.ToString("HH:mm:ss ") + msg + Environment.NewLine, Encoding.UTF8);
            }
            catch
            {
            }
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern int SearchPath(string path, string fileName, string extension, int bufferLength,
            StringBuilder buffer, IntPtr filePart);
    }

    /// <summary>静默启动用的消息循环载体：不显示主窗口，但保留其句柄与 WebView2。</summary>
    internal static class Uninstaller
    {
        /// <summary>延迟执行的卸载器主体（跑在临时副本里）。</summary>
        internal static int Run(string productCode, string installDir)
        {
            try
            {
                Thread.Sleep(2500);
                var psi = new ProcessStartInfo("msiexec.exe", "/x " + productCode + " /qn")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                using (var p = Process.Start(psi))
                {
                    if (p != null) p.WaitForExit(180000);
                }
                Thread.Sleep(1500);
                DeleteTree(Path.Combine(installDir, "app"));
                DeleteTree(Path.Combine(installDir, "userdata"));
                foreach (var log in Directory.GetFiles(installDir, "*.log"))
                {
                    try { File.Delete(log); } catch { }
                }
                Thread.Sleep(800);
                try { File.Delete(Application.ExecutablePath); } catch { }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Trace.WriteLine("uninstaller failed: " + ex.Message);
            }
            return 0;
        }

        internal static void DeleteTree(string path)
        {
            try
            {
                if (!Directory.Exists(path)) return;
                foreach (var file in Directory.GetFiles(path, "*", SearchOption.AllDirectories))
                {
                    try { File.SetAttributes(file, FileAttributes.Normal); File.Delete(file); } catch { }
                }
                foreach (var dir in Directory.GetDirectories(path, "*", SearchOption.AllDirectories))
                {
                    try { Directory.Delete(dir, true); } catch { }
                }
                Directory.Delete(path, true);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Trace.WriteLine("delete tree failed: " + path + " / " + ex.Message);
            }
        }

    }

    internal sealed class SilentContext : ApplicationContext
    {
        public SilentContext(Form form)
        {
            if (form != null)
            {
                form.Visible = false;
            }
        }
    }

    /// <summary>无边框窗口：圆角、阴影、边缘缩放、最大化不遮任务栏。</summary>
    internal sealed class ShellForm : Form
    {
        private const int WM_NCHITTEST = 0x0084;
        private const int WM_GETMINMAXINFO = 0x0024;
        private const int WM_DPICHANGED = 0x02E0;
        private const int HTLEFT = 10, HTRIGHT = 11, HTTOP = 12, HTTOPLEFT = 13, HTTOPRIGHT = 14;
        private const int HTBOTTOM = 15, HTBOTTOMLEFT = 16, HTBOTTOMRIGHT = 17;
        private const int ResizeBand = 6;
        private const int CornerRadius = 18;
        private readonly int showMessage = Native.RegisterWindowMessage(Native.SHOW_MESSAGE);
        private double dpiScale = 1.0;
        private bool dpiApplied;

        public ShellForm()
        {
            DoubleBuffered = true;
            SetStyle(ControlStyles.ResizeRedraw, true);
        }

        private static void TraceLine(string msg)
        {
            try
            {
                File.AppendAllText(
                    Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "rapoolite-trace.log"),
                    DateTime.Now.ToString("HH:mm:ss.fff") + " " + msg + Environment.NewLine);
            }
            catch
            {
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            ApplyDpiLayout();
            ApplyCorners();
        }

        /// <summary>窗口显示后再调一次：这时才拿得到所在显示器的真实 DPI。</summary>
        public void RefreshDpiLayout()
        {
            dpiApplied = false;
            ApplyDpiLayout();
            ApplyCorners();
        }

        /// <summary>按当前显示器 DPI 一次性定好窗口尺寸与圆角/拉伸边宽，200% 缩放下界面才不会被位图拉伸。</summary>
        private void ApplyDpiLayout()
        {
            if (dpiApplied)
            {
                return;
            }
            dpiApplied = true;
            var dpi = Native.WindowDpi(Handle);
            if (dpi > 0)
            {
                dpiScale = Math.Max(1.0, dpi / 96.0);
            }
            var area = Screen.FromHandle(Handle).WorkingArea;
            var maxW = Math.Max(720, area.Width - (int)Math.Round(40 * dpiScale));
            var maxH = Math.Max(520, area.Height - (int)Math.Round(40 * dpiScale));
            var sw = Math.Min((int)Math.Round(1280 * dpiScale), maxW);
            var sh = Math.Min((int)Math.Round(830 * dpiScale), maxH);
            TraceLine("dpi: raw=" + dpi + " scale=" + dpiScale.ToString("0.##") + " area=" + area.Width + "x" + area.Height + " -> " + sw + "x" + sh);
            MinimumSize = new Size(
                Math.Min((int)Math.Round(1024 * dpiScale), maxW),
                Math.Min((int)Math.Round(680 * dpiScale), maxH));
            Size = new Size(sw, sh);
            TraceLine("dpi: after set, ClientSize=" + ClientSize.Width + "x" + ClientSize.Height);
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            ApplyCorners();
        }

        private void ApplyCorners()
        {
            if (WindowState == FormWindowState.Maximized)
            {
                Native.SetWindowRgn(Handle, IntPtr.Zero, true);
                return;
            }
            var radius = (int)Math.Round(CornerRadius * dpiScale);
            var rgn = Native.CreateRoundRectRgn(0, 0, Width + 1, Height + 1, radius * 2, radius * 2);
            Native.SetWindowRgn(Handle, rgn, true);
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_GETMINMAXINFO && WindowState == FormWindowState.Maximized)
            {
                var mmi = (Native.MINMAXINFO)Marshal.PtrToStructure(m.LParam, typeof(Native.MINMAXINFO));
                var area = Screen.FromHandle(Handle).WorkingArea;
                mmi.ptMaxPosition.x = area.X - Bounds.X + (area.X - 0);
                mmi.ptMaxPosition.y = area.Y;
                mmi.ptMaxSize.x = area.Width;
                mmi.ptMaxSize.y = area.Height;
                Marshal.StructureToPtr(mmi, m.LParam, true);
                return;
            }

            // 跨显示器拖动导致 DPI 变化：只更新缩放比例与圆角，尺寸交给用户自己拖
            if (m.Msg == WM_DPICHANGED)
            {
                var dpi = Native.WindowDpi(Handle);
                if (dpi > 0)
                {
                    dpiScale = Math.Max(1.0, dpi / 96.0);
                }
                base.WndProc(ref m);
                ApplyCorners();
                return;
            }

            if (m.Msg == WM_NCHITTEST)
            {
                base.WndProc(ref m);
                var pos = PointToClient(new Point(m.LParam.ToInt32() & 0xFFFF, (m.LParam.ToInt32() >> 16) & 0xFFFF));
                if (WindowState != FormWindowState.Maximized)
                {
                    var band = (int)Math.Round(ResizeBand * dpiScale);
                    var left = pos.X <= band;
                    var right = pos.X >= ClientSize.Width - band;
                    var top = pos.Y <= band;
                    var bottom = pos.Y >= ClientSize.Height - band;
                    if (left && top) m.Result = (IntPtr)HTTOPLEFT;
                    else if (right && top) m.Result = (IntPtr)HTTOPRIGHT;
                    else if (left && bottom) m.Result = (IntPtr)HTBOTTOMLEFT;
                    else if (right && bottom) m.Result = (IntPtr)HTBOTTOMRIGHT;
                    else if (left) m.Result = (IntPtr)HTLEFT;
                    else if (right) m.Result = (IntPtr)HTRIGHT;
                    else if (top) m.Result = (IntPtr)HTTOP;
                    else if (bottom) m.Result = (IntPtr)HTBOTTOM;
                }
                return;
            }

            // 另一个实例想让我们把窗口亮出来
            if (m.Msg == showMessage && showMessage != 0)
            {
                Show();
                if (WindowState == FormWindowState.Minimized)
                {
                    WindowState = FormWindowState.Normal;
                }
                Activate();
                Native.SetForegroundWindow(Handle);
                return;
            }

            base.WndProc(ref m);
        }
    }

    /// <summary>托盘电量图标：绿 / 橙 / 红 / 灰。</summary>
    internal static class TrayIcons
    {
        /// <summary>判断当前 exe 是否已被任务栏通知区登记（Windows 11 会为每个图标在注册表建档）。</summary>
        public static string ShellRegistered(string exe)
        {
            try
            {
                using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Control Panel\NotifyIconSettings"))
                {
                    if (key == null) return "no settings key";
                    var names = key.GetSubKeyNames();
                    foreach (var name in names)
                    {
                        using (var sub = key.OpenSubKey(name))
                        {
                            if (sub == null) continue;
                            var p = sub.GetValue("ExecutablePath") as string;
                            if (p != null && p.Equals(exe, StringComparison.OrdinalIgnoreCase))
                            {
                                return "registered (" + names.Length + " total)";
                            }
                        }
                    }
                    return "not registered (" + names.Length + " total)";
                }
            }
            catch (Exception ex)
            {
                return "check failed: " + ex.Message;
            }
        }

        /// <summary>竖放电池图标：白色（>50%）、橙色（20–50%）、红色（&lt;20%），不写数字。</summary>
        public static Icon Build(int percent, bool connected)
        {
            using (var bmp = BuildBitmap(percent, connected))
            {
                return IconFromBitmap(bmp);
            }
        }

        /// <summary>直接返回 32x32 的位图，供预览/调试使用。</summary>
        public static Bitmap BuildBitmap(int percent, bool connected)
        {
            const int size = 32;
            var bmp = new Bitmap(size, size);
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);

                var unknown = !connected || percent < 0;
                var pct = Math.Max(0, Math.Min(100, percent));
                var color = unknown
                    ? Color.FromArgb(225, 158, 163, 173)
                    : pct < 20
                        ? Color.FromArgb(255, 236, 84, 84)
                        : pct <= 50
                            ? Color.FromArgb(255, 240, 165, 58)
                            : Color.FromArgb(255, 246, 247, 250);

                // 竖放电池：外壳 + 顶部正极 + 按电量的实心填充
                const float bx = 8.6f, by = 3.6f, bw = 14.8f, bh = 25.4f, br = 3.4f, bwid = 2.6f;
                using (var shell = new Pen(color, bwid))
                using (var path = RoundRect(bx, by, bw, bh, br))
                {
                    g.DrawPath(shell, path);
                }
                using (var nub = new SolidBrush(color))
                {
                    g.FillRectangle(nub, bx + bw / 2f - 2.7f, by - 2.7f, 5.4f, 3f);
                }

                if (!unknown && pct > 0)
                {
                    var fillH = (bh - bwid * 2 - 1.4f) * (pct / 100f);
                    using (var brush = new SolidBrush(color))
                    using (var path = RoundRect(
                        bx + bwid / 2f + 0.9f,
                        by + bh - bwid / 2f - 0.7f - fillH,
                        Math.Max(1.4f, bw - bwid - 1.8f),
                        Math.Max(1.4f, fillH),
                        1.4f))
                    {
                        g.FillPath(brush, path);
                    }
                }

            }
            return bmp;
        }

        /// <summary>把位图包成标准 ICO 数据流再生成 Icon —— 不依赖 HICON 句柄的生命周期，句柄不会被别处销毁。</summary>
        public static Icon IconFromBitmap(Bitmap bmp)
        {
            byte[] png;
            using (var ms = new MemoryStream())
            {
                bmp.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
                png = ms.ToArray();
            }

            using (var ico = new MemoryStream())
            using (var w = new BinaryWriter(ico))
            {
                w.Write((short)0);            // reserved
                w.Write((short)1);            // type: icon
                w.Write((short)1);            // count
                w.Write((byte)bmp.Width);     // width
                w.Write((byte)bmp.Height);    // height
                w.Write((byte)0);             // palette
                w.Write((byte)0);             // reserved
                w.Write((short)1);            // planes
                w.Write((short)32);           // bpp
                w.Write(png.Length);          // bytes in resource
                w.Write(22);                  // offset
                w.Write(png);
                w.Flush();
                ico.Position = 0;
                // Icon 会把流内容复制一份，之后原流释放也不影响
                using (var loaded = new Icon(ico))
                {
                    return (Icon)loaded.Clone();
                }
            }
        }

        private static GraphicsPath RoundRect(float x, float y, float w, float h, float r)
        {
            var path = new GraphicsPath();
            var d = r * 2;
            path.AddArc(x, y, d, d, 180, 90);
            path.AddArc(x + w - d, y, d, d, 270, 90);
            path.AddArc(x + w - d, y + h - d, d, d, 0, 90);
            path.AddArc(x, y + h - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }
    }

    /// <summary>右下角的 DPI 切换提示：无边框、置顶、不抢焦点、不占任务栏。</summary>
    internal sealed class OsdForm : Form
    {
        private readonly System.Windows.Forms.Timer life;
        private DateTime holdUntil = DateTime.MinValue;
        private bool fadingOut;
        private double scale = 1.0;
        private string dpiText = "";
        private string subText = "";
        private int slotIndex;
        private int slotCount;

        public OsdForm()
        {
            AutoScaleMode = AutoScaleMode.None;
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = false;
            TopMost = true;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
            BackColor = Color.FromArgb(20, 22, 28);
            Opacity = 0;

            life = new System.Windows.Forms.Timer { Interval = 30 };
            life.Tick += (s, e) => Step();
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
                cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW
                cp.ExStyle |= 0x00000008; // WS_EX_TOPMOST
                cp.ExStyle |= 0x00000020; // WS_EX_TRANSPARENT（鼠标穿透）
                return cp;
            }
        }

        public void Popup(int dpi, int index, int count)
        {
            try
            {
                dpiText = dpi > 0 ? dpi.ToString() : "—";
                subText = string.Format("DPI · 第 {0} 档{1}", index + 1, count > 1 ? " / " + count : "");
                slotIndex = index;
                slotCount = count;
                var handle = Handle; // 先建句柄，拿到真实 DPI 再排版
                scale = Math.Max(1.0, DeviceDpi / 96.0);
                LayoutBox();
                fadingOut = false;
                holdUntil = DateTime.MinValue;
                Opacity = 0;
                if (!Visible) Show();
                Invalidate();
                life.Start();
            }
            catch
            {
            }
        }

        private void LayoutBox()
        {
            var w = (int)Math.Round(252 * scale);
            var h = (int)Math.Round(118 * scale);
            Size = new Size(w, h);
            var wa = Screen.FromControl(this).WorkingArea;
            Location = new Point(
                wa.Right - w - (int)Math.Round(24 * scale),
                wa.Bottom - h - (int)Math.Round(24 * scale));

            using (var path = RoundRect(new Rectangle(0, 0, w, h), (int)Math.Round(20 * scale)))
            {
                Region = new Region(path);
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;

            var w = ClientSize.Width;
            var h = ClientSize.Height;
            using (var f1 = new Font("Segoe UI", (float)(25 * scale), FontStyle.Bold))
            using (var f2 = new Font("Microsoft YaHei UI", (float)(9.5 * scale)))
            using (var f2b = new Font("Microsoft YaHei UI", (float)(9.5 * scale), FontStyle.Bold))
            using (var b1 = new SolidBrush(Color.White))
            using (var b2 = new SolidBrush(Color.FromArgb(178, 184, 198)))
            using (var b3 = new SolidBrush(Color.FromArgb(132, 138, 152)))
            using (var b4 = new SolidBrush(Color.White))
            using (var sfCenter = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
            using (var sf = StringFormat.GenericTypographic)
            {
                g.DrawString(dpiText, f1, b1,
                    new RectangleF(0, (float)(8 * scale), w, (float)(60 * scale)), sfCenter);

                // 第二行分段绘制（当前档位数字加粗），段间用等宽间距，避免空格测量不一致
                var parts = new List<object[]>
                {
                    new object[] { "第", f2, b2 },
                    new object[] { (slotIndex + 1).ToString(), f2b, b4 },
                    new object[] { "档", f2, b2 },
                };
                if (slotCount > 1)
                {
                    parts.Add(new object[] { "/ " + slotCount, f2, b3 });
                }

                var sizes = new List<float>();
                var tflags = TextFormatFlags.NoPadding | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix;
                foreach (var part in parts)
                {
                    sizes.Add(TextRenderer.MeasureText(g, (string)part[0], (Font)part[1], Size.Empty, tflags).Width);
                }

                var gaps = new List<float>();
                for (var i = 0; i < parts.Count - 1; i++)
                {
                    // 最后一段（/ N）前留更宽的间距
                    gaps.Add((i == 0 ? 5.5f : i == 1 ? 4.2f : 8f) * (float)scale);
                }

                var total = 0f;
                foreach (var s in sizes) total += s;
                foreach (var gp in gaps) total += gp;

                var y = (float)(72 * scale);
                var x = (w - total) / 2f;
                for (var i = 0; i < parts.Count; i++)
                {
                    TextRenderer.DrawText(g, (string)parts[i][0], (Font)parts[i][1],
                        new Point((int)Math.Round(x), (int)Math.Round(y)), ((SolidBrush)parts[i][2]).Color, tflags);
                    x += sizes[i];
                    if (i < gaps.Count) x += gaps[i];
                }
            }
        }

        private static GraphicsPath RoundRect(Rectangle r, int radius)
        {
            var path = new GraphicsPath();
            var d = radius * 2;
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d - 1, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d - 1, r.Bottom - d - 1, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d - 1, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        private void Step()
        {
            if (holdUntil == DateTime.MinValue)
            {
                Opacity = Math.Min(0.97, Opacity + 0.16);
                if (Opacity >= 0.97) holdUntil = DateTime.Now.AddMilliseconds(1700);
                return;
            }
            if (!fadingOut && DateTime.Now >= holdUntil) fadingOut = true;
            if (fadingOut)
            {
                Opacity = Math.Max(0, Opacity - 0.1);
                if (Opacity <= 0.01)
                {
                    life.Stop();
                    Hide();
                }
            }
        }
    }
    internal static class Native
    {
        public const int WM_NCLBUTTONDOWN = 0x00A1;
        public const int HTCAPTION = 2;

        [DllImport("user32.dll")]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        [DllImport("user32.dll")]
        private static extern uint GetDpiForWindow(IntPtr hwnd);

        /// <summary>某个窗口所在显示器的 DPI（96 = 100%，192 = 200%）。</summary>
        public static int WindowDpi(IntPtr hwnd)
        {
            try
            {
                var dpi = GetDpiForWindow(hwnd);
                if (dpi > 0)
                {
                    return (int)dpi;
                }
            }
            catch
            {
            }
            return SystemDpi();
        }

        [DllImport("user32.dll")]
        private static extern uint GetDpiForSystem();

        [DllImport("gdi32.dll")]
        private static extern int GetDeviceCaps(IntPtr hdc, int index);

        [DllImport("user32.dll")]
        private static extern IntPtr GetDC(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);

        /// <summary>没带清单运行时兜底打开 Per-Monitor V2；已有清单则调用失败但不影响。</summary>
        public static void EnablePerMonitorDpi()
        {
            try
            {
                // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
                SetProcessDpiAwarenessContext(new IntPtr(-4));
            }
            catch
            {
            }
        }

        /// <summary>系统 DPI（96 = 100%，192 = 200%）。</summary>
        public static int SystemDpi()
        {
            try
            {
                var dpi = GetDpiForSystem();
                if (dpi > 0)
                {
                    return (int)dpi;
                }
            }
            catch
            {
            }
            var hdc = GetDC(IntPtr.Zero);
            try
            {
                // LOGPIXELSX = 88
                var dpi = GetDeviceCaps(hdc, 88);
                return dpi > 0 ? dpi : 96;
            }
            finally
            {
                ReleaseDC(IntPtr.Zero, hdc);
            }
        }

        [DllImport("shcore.dll")]
        private static extern int GetDpiForMonitor(IntPtr hmon, int dpiType, out uint dpiX, out uint dpiY);

        [DllImport("user32.dll")]
        private static extern IntPtr MonitorFromPoint(POINT pt, uint flags);

        /// <summary>主显示器实际缩放 DPI（Per-Monitor V2 下生效，200% 时返回 192）。</summary>
        public static int PrimaryMonitorDpi()
        {
            try
            {
                var pt = new POINT();
                pt.x = 0;
                pt.y = 0;
                // MONITOR_DEFAULTTOPRIMARY = 1, MDT_EFFECTIVE_DPI = 0
                var mon = MonitorFromPoint(pt, 1);
                if (mon != IntPtr.Zero)
                {
                    uint dx, dy;
                    if (GetDpiForMonitor(mon, 0, out dx, out dy) == 0 && dx > 0)
                    {
                        return (int)dx;
                    }
                }
            }
            catch
            {
            }
            return SystemDpi();
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int x;
            public int y;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MINMAXINFO
        {
            public POINT ptReserved;
            public POINT ptMaxSize;
            public POINT ptMaxPosition;
            public POINT ptMinTrackSize;
            public POINT ptMaxTrackSize;
        }

        [DllImport("user32.dll")]
        public static extern bool ReleaseCapture();

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool DestroyIcon(IntPtr handle);

        [DllImport("user32.dll")]
        public static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool redraw);

        [DllImport("gdi32.dll")]
        public static extern IntPtr CreateRoundRectRgn(int left, int top, int right, int bottom, int width, int height);

        public const int SW_SHOW = 5;

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr FindWindow(string className, string windowTitle);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int cmdShow);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

        public const string SHOW_MESSAGE = "RapooLite$ShowWindow";
        public static readonly IntPtr HWND_BROADCAST = new IntPtr(0xFFFF);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int RegisterWindowMessage(string message);

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        public static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        /// <summary>窗口是否属于另一个存活的 RapooLite 进程（避免被残留的孤儿窗口骗到）。</summary>
        public static bool OwnerIsRapooLite(IntPtr hWnd)
        {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid == 0 || pid == (uint)Process.GetCurrentProcess().Id)
            {
                return false;
            }
            try
            {
                return string.Equals(Process.GetProcessById((int)pid).ProcessName, "RapooLite", StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                return false;
            }
        }
    }
}
