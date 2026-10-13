using System.Windows;

namespace Tangocho;

public partial class App : Application
{
    const string MutexName = "Tangocho.SingleInstance";
    const string ActivateEventName = "Tangocho.Activate";

    Mutex? _mutex;
    EventWaitHandle? _activate;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        // Первый запуск из «Загрузок» — ставим себя в AppData и создаём ярлыки
        if (Installer.InstallIfNeeded(e.Args))
        {
            Shutdown();
            return;
        }

        // Только одно окно. После обновления старый процесс ещё закрывается — ждём его.
        _mutex = new Mutex(false, MutexName);
        bool owned;
        try { owned = _mutex.WaitOne(e.Args.Contains("--updated") ? TimeSpan.FromSeconds(20) : TimeSpan.Zero); }
        catch (AbandonedMutexException) { owned = true; }

        if (!owned)
        {
            // Уже запущено — просим то окно показаться
            try { EventWaitHandle.OpenExisting(ActivateEventName).Set(); } catch { }
            Shutdown();
            return;
        }

        // После обновления убираем старый exe
        Updater.CleanupOld();

        var win = new Tangocho.MainWindow(justUpdated: e.Args.Contains("--updated"));
        MainWindow = win;
        win.Show();

        _activate = new EventWaitHandle(false, EventResetMode.AutoReset, ActivateEventName);
        var t = new Thread(() =>
        {
            while (_activate.WaitOne())
                Dispatcher.Invoke(() => win.BringToFront());
        }) { IsBackground = true };
        t.Start();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        try { _mutex?.ReleaseMutex(); } catch { }
        base.OnExit(e);
    }
}
