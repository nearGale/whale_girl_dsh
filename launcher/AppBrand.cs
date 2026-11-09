using System;
using System.IO;

namespace WhaleLauncher
{
    /// <summary>
    /// 窗口/弹窗品牌名。安装包只有 publish 出来的 exe，没有 launcher 工程文件；
    /// 源码树根目录跑启动器时才带 Dev，避免正式版也显示「鲸鲸Dev」。
    /// </summary>
    internal static class AppBrand
    {
        public static bool IsDev { get; } = DetectDev();

        public static string Name => IsDev ? "鲸鲸Dev" : "鲸鲸";

        private static bool DetectDev()
        {
            try
            {
                var root = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                return File.Exists(Path.Combine(root, "launcher", "WhaleLauncher.csproj"));
            }
            catch
            {
                return false;
            }
        }
    }
}
