// ForceStudioV2.exe: one file that unpacks the studio in %LOCALAPPDATA% and starts it.
// Built by scripts/make-single-exe.mjs with the C# compiler that ships with Windows (no extra tools).
//   ForceStudioV2.exe          unpack (once per build) then start Force Studio v2 and open the studio
//   ForceStudioV2.exe --stop   ask a running Force Studio v2 to stop
// The app files live in %LOCALAPPDATA%\ForceStudioV2\app (replaced when a new build is unpacked);
// the songs and settings live in %LOCALAPPDATA%\ForceStudioV2\data and survive updates.
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

static class Boot
{
    const string Title = "Force Studio v2";
    const string PayloadName = "payload.zip";
    // Replaced by the build script.
    const string Stamp = "@STAMP@";
    const int Port = @PORT@;

    [STAThread]
    static int Main(string[] args)
    {
        string url = "http://127.0.0.1:" + Port;
        if (args.Length > 0 && args[0] == "--stop")
        {
            Stop(url);
            return 0;
        }
        if (IsRunning(url))
        {
            Open(url);
            return 0;
        }
        string baseDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ForceStudioV2"
        );
        string appDir = Path.Combine(baseDir, "app");
        string dataDir = Path.Combine(baseDir, "data");
        try
        {
            Unpack(baseDir, appDir);
            Directory.CreateDirectory(dataDir);
            // The first run of the renamed build brings over the library of the old folder, if there is one.
            MigrateOldLibrary(dataDir);
        }
        catch (Exception error)
        {
            // Written before the dialog so a failed unpack can be diagnosed without guessing.
            try
            {
                File.AppendAllText(
                    Path.Combine(baseDir, "boot-error.log"),
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + error.ToString() + "\r\n"
                );
            }
            catch (Exception)
            {
                /* the log is best effort */
            }
            MessageBox.Show(
                "The studio could not be unpacked in " + baseDir + ".\n\n" + error.Message,
                Title,
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
            return 1;
        }
        string node = Path.Combine(appDir, "runtime", "node", "node.exe");
        if (!File.Exists(node))
        {
            MessageBox.Show(
                "The bundled Node.js runtime is missing from " + appDir + ".\n\nRun the EXE again: it unpacks the studio on every new build.",
                Title,
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
            return 1;
        }
        ProcessStartInfo start = new ProcessStartInfo(node, "server.mjs");
        start.WorkingDirectory = appDir;
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.EnvironmentVariables["FORCE_STUDIO_DATA_DIR"] = dataDir;
        try
        {
            Process.Start(start);
        }
        catch (Exception error)
        {
            MessageBox.Show("Force Studio v2 could not start.\n\n" + error.Message, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        for (int attempt = 0; attempt < 150; attempt++)
        {
            Thread.Sleep(400);
            if (IsRunning(url))
            {
                Open(url);
                return 0;
            }
        }
        MessageBox.Show(
            "Force Studio v2 did not start within a minute.\n\nComfyUI may be starting on a busy graphics card: wait a moment and open "
                + url
                + " in your browser.",
            Title,
            MessageBoxButtons.OK,
            MessageBoxIcon.Warning
        );
        return 1;
    }

    // Copy the songs and settings of the previous name (%LOCALAPPDATA%\SonoraYuE2Studio\data) into the new folder, once.
    static void MigrateOldLibrary(string dataDir)
    {
        try
        {
            if (Directory.Exists(dataDir) && Directory.GetFileSystemEntries(dataDir).Length > 0) return;
            string old = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "SonoraYuE2Studio",
                "data"
            );
            if (!Directory.Exists(old)) return;
            CopyFolder(old, dataDir);
        }
        catch (Exception)
        {
            /* a failed copy only means an empty library: never block the start */
        }
    }

    static void CopyFolder(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (string folder in Directory.GetDirectories(from))
            CopyFolder(folder, Path.Combine(to, Path.GetFileName(folder)));
        foreach (string file in Directory.GetFiles(from))
            File.Copy(file, Path.Combine(to, Path.GetFileName(file)), true);
    }

    // Extract the bundled studio unless this exact build is already there.
    static void Unpack(string baseDir, string appDir)
    {
        string stampFile = Path.Combine(baseDir, "build.txt");
        try
        {
            if (File.Exists(stampFile) && File.ReadAllText(stampFile).Trim() == Stamp && Directory.Exists(appDir))
                return;
        }
        catch (Exception)
        {
            /* unreadable stamp: unpack again */
        }
        Assembly assembly = Assembly.GetExecutingAssembly();
        using (Stream payload = assembly.GetManifestResourceStream(PayloadName))
        {
            if (payload == null) throw new Exception("The embedded studio files are missing.");
            if (Directory.Exists(appDir))
            {
                // Only ever the app folder is removed: data lives next to it.
                Directory.Delete(appDir, true);
            }
            Directory.CreateDirectory(appDir);
            string zip = Path.Combine(baseDir, "payload.zip");
            using (FileStream file = File.Create(zip)) payload.CopyTo(file);
            ZipFile.ExtractToDirectory(zip, appDir);
            File.Delete(zip);
        }
        File.WriteAllText(stampFile, Stamp);
    }

    static bool IsRunning(string url)
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url + "/api/state");
            request.Timeout = 2000;
            request.Proxy = null;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                return response.StatusCode == HttpStatusCode.OK;
        }
        catch (Exception)
        {
            return false;
        }
    }

    static void Stop(string url)
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url + "/api/shutdown");
            request.Method = "POST";
            request.Headers.Add("X-Force-Studio", "1");
            request.ContentLength = 0;
            request.Timeout = 5000;
            request.Proxy = null;
            request.GetResponse().Close();
        }
        catch (Exception)
        {
            /* not running */
        }
    }

    static void Open(string url)
    {
        try
        {
            Process.Start(url);
        }
        catch (Exception)
        {
            MessageBox.Show("Force Studio v2 is running. Open " + url + " in your browser.", Title);
        }
    }
}
