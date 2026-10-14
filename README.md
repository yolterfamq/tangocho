# Тангочо

Японские карточки (урок 4) для Windows, Android и браузера: автообновления через GitHub, аккаунты с синхронизацией прогресса и ИИ-репетитор Ребека.

- Один релиз собирает сразу `Tangocho.exe` и `Tangocho.apk`.
- Сайт сам публикуется на GitHub Pages: `https://yolterfamq.github.io/tangocho/`.
- Всё общее (слова, вид, аккаунт, Ребека) лежит в папке `web/`.

## Первая настройка (один раз)

1. Создай на GitHub **публичный** репозиторий, например `tangocho`. С приватным автообновление у других не заработает.
2. Распакуй этот архив в папку, открой там терминал и выполни:
   ```
   git init
   git add -A
   git commit -m "Тангочо"
   git branch -M main
   git remote add origin https://github.com/ТВОЙ_НИК/tangocho.git
   git push -u origin main
   ```
3. Выпусти первую версию:
   ```
   release.bat 1.0.0 "Первая версия"
   ```
4. Открой вкладку **Actions** в репозитории. Через 3–5 минут сборка закончится, и во вкладке **Releases** появится `Tangocho.exe`. Этот файл ты и раздаёшь людям.

## Ключ подписи для Android (один раз)

Android ставит обновление только поверх приложения, подписанного тем же ключом. Поэтому ключ хранится в секретах GitHub:

1. В репозитории открой **Settings → Secrets and variables → Actions → New repository secret**.
2. Создай секрет `ANDROID_KEYSTORE_B64`. В значение вставь всё содержимое файла `ANDROID_KEYSTORE_B64.txt`.
3. Создай секрет `ANDROID_KEYSTORE_PASSWORD`. В значение вставь содержимое `ANDROID_KEYSTORE_PASSWORD.txt`.
4. Сохрани файл `tangocho-release.jks` где-нибудь в надёжном месте, не в репозитории. Если ключ потеряется, обновлять уже установленные приложения не получится: их придётся удалить и поставить заново, а прогресс при этом пропадёт.

## Аккаунты: Firebase (один раз)

1. Открой https://console.firebase.google.com → **Создать проект** (например `tangocho`). Google Analytics можно выключить.
2. **Build → Authentication → Get started → Sign-in method** — включи **Google** (укажи свою почту поддержки) и **Email/Password**.
3. **Authentication → Settings → Authorized domains → Add domain** — добавь `yolterfamq.github.io`.
4. **Build → Firestore Database → Create database** → режим *production*, регион поближе (например `eur3`). Вкладка **Rules** → вставь содержимое `firestore.rules` → **Publish**.
5. **⚙ Project settings → Your apps → Web (`</>`)** → зарегистрируй приложение → скопируй `apiKey`, `authDomain`, `projectId`, `appId` в `web/config.js`.

## Ребека: Gemini + Cloudflare (один раз)

1. Ключ Gemini: https://aistudio.google.com → **Get API key → Create API key** → скопируй.
2. https://dash.cloudflare.com (регистрация бесплатная) → **Workers & Pages → Create → Worker** → имя `rebecca` → **Deploy**.
3. **Edit code** → замени весь код содержимым `rebecca-worker/worker.js` → **Deploy**.
4. Воркер → **Settings → Variables and Secrets → Add**:
   - `GEMINI_API_KEY` — тип **Secret**, ключ из шага 1;
   - `FIREBASE_PROJECT_ID` — id проекта Firebase (из `config.js`);
   - `ALLOWED_EMAILS` — почты через запятую, кому можно говорить с Ребекой: твоя и её.
5. Воркер → **Settings → Runtime → Placement → Smart**. Так запросы к Gemini пойдут из дата-центра рядом с Google, и не будет ошибки «регион не поддерживается».
6. Скопируй адрес воркера (`https://rebecca.<что-то>.workers.dev`) в `rebeccaUrl` в `web/config.js`.

Если входите по почте и паролю, почту нужно подтвердить: письмо приходит при регистрации. С Google-аккаунтом подтверждать ничего не нужно.

## Сайт: GitHub Pages (один раз)

В репозитории: **Settings → Pages → Source: GitHub Actions**. После каждого пуша, где менялась папка `web/`, сайт обновится сам.

## Как выпустить обновление

1. Поменяй что нужно, например слова в `web/index.html`.
2. Запусти:
   ```
   release.bat 1.0.1 "Добавил урок 5"
   ```
   Каждый раз бери номер больше предыдущего.
3. GitHub сам соберёт новый `Tangocho.exe` и выложит релиз.

## Установка на Android

1. Скачай `Tangocho.apk` из Releases и отправь, например, в Telegram.
2. На телефоне нажми на файл. Android попросит разрешить установку из Telegram: разреши и нажми «Установить».
3. Обновления: при запуске приложение само скачивает новую версию, сверху появляется «Обновление готово · Установить». В первый раз телефон попросит разрешить Тангочо устанавливать приложения: включи и вернись назад. Дальше достаточно нажать «Установить» → «Обновить». Прогресс сохраняется.

## Что происходит у пользователей на ПК

- При первом запуске `Tangocho.exe` ставит себя в `%LocalAppData%\Programs\Tangocho`, создаёт ярлыки в «Пуске» и на рабочем столе и открывается оттуда. Права администратора не нужны.
- При каждом запуске программа проверяет GitHub. Если там есть версия новее, она тихо скачивается. Сверху появляется плашка «Обновление готово · Перезапустить». Если её не нажать, обновление встанет само при закрытии программы.
- В **Настройках → Обновления** есть кнопка «Проверить обновления», текущая версия, текст «что нового» и переключатель автоскачивания.
- Прогресс по карточкам хранится в `%LocalAppData%\Tangocho` и не теряется при обновлениях.

## Где что лежит

| Файл | Что это |
|---|---|
| `web/index.html` | Сами карточки: слова, вид, логика повторений |
| `web/config.js` | Настройки Firebase и адрес Ребеки |
| `web/account.js` | Вход и синхронизация прогресса |
| `web/rebecca.js` | Чат с Ребекой: фото, история, формулы |
| `web/auth.html` | Страница входа через Google для приложений |
| `rebecca-worker/worker.js` | Сервер Ребеки для Cloudflare (ключ Gemini хранится там) |
| `firestore.rules` | Правила базы: каждый видит только свои данные |
| `MainWindow.xaml(.cs)` | Окно программы и связь со страницей |
| `Updater.cs` | Проверка, скачивание и установка обновлений с GitHub |
| `Installer.cs` | Установка при первом запуске и ярлыки |
| `android/` | Android-приложение (Java, WebView + обновления) |
| `.github/workflows/release.yml` | Сборка exe и apk и релиз на GitHub по тегу |
| `.github/workflows/pages.yml` | Публикация сайта на GitHub Pages |
| `release.bat` | Выпуск новой версии одной командой |
| `tools/pages.yml` | Копия workflow сайта: release.bat кладёт её в .github/workflows, если там её нет |

## Сборка у себя (необязательно)

Нужен .NET 8 SDK:
```
dotnet run
```
В локальной сборке автообновление выключено: репозиторий для обновлений подставляет GitHub Actions при релизе.
