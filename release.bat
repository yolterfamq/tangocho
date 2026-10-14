@echo off
chcp 65001 >nul
setlocal

rem  Выпуск новой версии:
rem    release.bat 1.0.1 "Что нового в этой версии"
rem  Скрипт коммитит изменения, ставит тег v1.0.1 и пушит на GitHub.
rem  Дальше GitHub сам соберёт Tangocho.exe и выложит релиз,
rem  а у всех пользователей программа скачает обновление сама.

if "%~1"=="" (
  echo Укажи версию, например:  release.bat 1.0.1 "Исправил перевод"
  exit /b 1
)

set VER=%~1
set NOTES=%~2
if "%NOTES%"=="" set NOTES=Версия %VER%

git rev-parse "v%VER%" >nul 2>&1 && (
  echo Версия v%VER% уже есть. Возьми номер побольше.
  exit /b 1
)

powershell -NoProfile -Command "(Get-Content Tangocho.csproj -Raw -Encoding UTF8) -replace '<Version>[^<]*</Version>', '<Version>%VER%</Version>' | Set-Content Tangocho.csproj -Encoding UTF8 -NoNewline"

rem Разовая настройка: публикация сайта на GitHub Pages
if not exist ".github\workflows\pages.yml" if exist "tools\pages.yml" copy /y "tools\pages.yml" ".github\workflows\pages.yml" >nul
rem Собранные программы не храним в репозитории (они лежат в Releases)
git rm -r --cached --quiet --ignore-unmatch -- "*.exe" "*.apk" >nul 2>&1

git add -A
git commit -m "Версия %VER%" || echo Нет новых изменений, ставлю только тег.
git push -u origin HEAD
if errorlevel 1 (
  echo.
  echo Не получилось отправить код на GitHub. Тег не поставлен.
  echo Если на GitHub есть изменения, которых нет у тебя, сначала выполни:  git pull --rebase
  exit /b 1
)
git tag -a "v%VER%" -m "%NOTES%"
git push origin "v%VER%"
if errorlevel 1 (
  echo Не получилось отправить тег v%VER%.
  exit /b 1
)

echo.
echo Готово! Сборка идёт тут: Actions в твоём репозитории на GitHub.
echo Через 3-5 минут релиз v%VER% появится, и у всех начнётся обновление.
endlocal
