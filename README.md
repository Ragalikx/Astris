<p align="center">
  <img src="web/astris-logo.svg" width="112" height="112" alt="Astris">
</p>

<h1 align="center">Astris</h1>

<p align="center">
  <img src="https://img.shields.io/badge/Minecraft-26.3-5aa83f?style=flat-square" alt="Minecraft 26.3">
  <img src="https://img.shields.io/badge/status-beta-e0b45a?style=flat-square" alt="Beta">
  <a href="https://astris-bcu.pages.dev/"><img src="https://img.shields.io/badge/play-astris--bcu.pages.dev-4c8bf5?style=flat-square" alt="Play: astris-bcu.pages.dev"></a>
  <img src="https://img.shields.io/badge/license-MIT-9b8fd8?style=flat-square" alt="MIT">
</p>

<p align="center">
  <a href="#english">English</a> · <a href="#русский">Русский</a> · <a href="#українська">Українська</a>
</p>

<!-- Video: drag an .mp4 into this file in GitHub's editor and keep the link it gives on its own line here. -->

---

## English

**Astris is Minecraft rewritten in Rust, running in a browser tab.** It is compatible with Java Edition 26.3: it uses that version's game files and worlds. Nothing to install and no Java needed: open the site, press Play, and the game starts.

Under the hood is [Horizon](https://github.com/horizon-rust/horizon), a reimplementation of the game in Rust, compiled for the web. The game runs on your own computer and uses your graphics card, the browser only hosts it.

> 🧪 **This is the first beta.** Things will break now and then. If you run into a problem, please send us the log (see below), it helps a lot.

### 🚀 Getting started

1. Install the **Horizon launcher**, sign in with the Microsoft account that owns Minecraft: Java Edition, and press **Prepare** on a build. This confirms you own the game.
2. Open Astris and press **Play**. The first time, it asks for the game files:
   - **From this computer**: choose the prepared folder, or a ZIP of it.
   - **Online install**: download them over the network from your own computer or NAS.
3. The copy takes about half a minute. Afterwards the folder is no longer needed, everything is kept in the browser.

### 💻 Requirements

- An up-to-date Chromium-based browser such as **Chrome, Edge or Brave**. We test on Chromium only, so we can't vouch for other browsers.
- A graphics card the browser allows the game to use (WebGPU).
- At least 4 GB of RAM. On weaker laptops, a lower render distance works best.
- On **Linux**, WebGPU has to be enabled by hand: turn on `Unsafe WebGPU Support` and `Vulkan` in `chrome://flags` (or `brave://flags`) and restart the browser.

### 🔒 Everything stays on your device

Astris has no server side. Game files, worlds, settings and logs are stored in your browser's own storage on your device, and the site sends none of it anywhere. There are no accounts and no analytics. The only things the site downloads from elsewhere are its fonts (from Google Fonts) and, if you use Online install, the game files from the address you enter.

### 🐛 Known issues

- **The browser may not let the game use your graphics card.** WebGPU can be turned off, or the browser may fall back to rendering on the processor, which is far too slow for the game. When this happens, the game shows what to enable. On Linux the flags above almost always fix it.
- **On laptops with two graphics cards**, the game may run on the integrated one. It still works, only slower. This depends on your system settings, not on the site.
- **A very high render distance can crash the tab.** We recommend keeping it at 12 chunks or lower. The 64-bit build (Settings → Experimental) allows more, but it is less tested and may cause other problems.
- **The first visit to a large world can take a while**, since the world loads gradually around you.
- **There is no multiplayer yet.** Playing together is planned for a future version.

### 📝 Reporting a problem

Press **Ctrl+Shift+L** in the game, then **Save**: that is the log. Logs of every launch are also kept in the launcher under **Settings → Logs**. Please attach it and describe what you were doing when the problem happened.

### ⚖️ License

The Astris and Horizon code is released under the MIT license. Textures, sounds and game data are not part of Astris: they come from your own copy of the game and stay in your browser. Astris is not affiliated with Mojang Studios or Microsoft. Minecraft is a trademark of Mojang Synergies AB.

---

## Русский

**Astris это Minecraft, переписанный на Rust и работающий во вкладке браузера.** Он совместим с Java Edition 26.3: использует файлы игры и миры этой версии. Ничего не нужно устанавливать, Java тоже не нужна: откройте сайт, нажмите «Играть», и игра запустится.

В основе лежит [Horizon](https://github.com/horizon-rust/horizon), реализация игры на Rust, собранная для веба. Игра работает на вашем компьютере и использует вашу видеокарту, браузер только запускает её.

> 🧪 **Это первая бета-версия.** Время от времени что-то будет ломаться. Если вы столкнулись с проблемой, пришлите, пожалуйста, лог (как это сделать, описано ниже), это очень помогает.

### 🚀 Как начать

1. Установите **лаунчер Horizon**, войдите в аккаунт Microsoft, на котором куплен Minecraft: Java Edition, и нажмите **«Подготовить»** у нужной сборки. Так подтверждается, что игра принадлежит вам.
2. Откройте Astris и нажмите **«Играть»**. При первом запуске он попросит файлы игры:
   - **С этого компьютера**: выберите подготовленную папку или ZIP-архив с ней.
   - **Онлайн-установка**: скачайте их по сети со своего компьютера или NAS.
3. Копирование занимает около полуминуты. После этого папка больше не нужна, всё хранится в браузере.

### 💻 Системные требования

- Актуальный браузер на движке Chromium, например **Chrome, Edge или Brave**. Мы тестируем только на Chromium, поэтому за работу в других браузерах не ручаемся.
- Видеокарта, которую браузер разрешает использовать игре (WebGPU).
- Не меньше 4 ГБ оперативной памяти. На слабых ноутбуках лучше уменьшить дальность прорисовки.
- На **Linux** WebGPU нужно включить вручную: включите `Unsafe WebGPU Support` и `Vulkan` в `chrome://flags` (или `brave://flags`) и перезапустите браузер.

### 🔒 Всё хранится у вас

У Astris нет серверной части. Файлы игры, миры, настройки и логи хранятся в хранилище браузера на вашем устройстве, и сайт никуда их не отправляет. Аккаунтов и аналитики нет. Со сторонних адресов сайт загружает только шрифты (с Google Fonts) и, если вы пользуетесь онлайн-установкой, файлы игры с адреса, который вы укажете.

### 🐛 Известные проблемы

- **Браузер может не дать игре доступ к видеокарте.** WebGPU бывает выключен, или браузер переходит на отрисовку процессором, а этого для игры слишком мало. В таком случае игра сама подскажет, что включить. На Linux почти всегда помогают флаги, описанные выше.
- **На ноутбуках с двумя видеокартами** игра может запуститься на встроенной. Она будет работать, но медленнее. Это зависит от настроек системы, а не от сайта.
- **Слишком большая дальность прорисовки может привести к вылету вкладки.** Рекомендуем ставить не больше 12 чанков. 64-битная сборка («Настройки → Эксперименты») позволяет больше, но она меньше проверена и может вызвать другие проблемы.
- **Первый вход в большой мир может занять время**, потому что мир подгружается вокруг вас постепенно.
- **Сетевой игры пока нет.** Игра вместе запланирована в одной из следующих версий.

### 📝 Как сообщить о проблеме

Нажмите в игре **Ctrl+Shift+L**, затем **Save**: это и есть лог. Логи всех запусков также хранятся в лаунчере, в разделе **«Настройки → Логи»**. Приложите лог и опишите, что вы делали, когда возникла проблема.

### ⚖️ Лицензия

Код Astris и Horizon распространяется по лицензии MIT. Текстуры, звуки и данные игры не входят в Astris: они берутся из вашей копии игры и хранятся в вашем браузере. Astris не связан с Mojang Studios и Microsoft. Minecraft является товарным знаком Mojang Synergies AB.

---

## Українська

**Astris це Minecraft, переписаний на Rust, що працює у вкладці браузера.** Він сумісний із Java Edition 26.3: використовує файли гри й світи цієї версії. Нічого не потрібно встановлювати, Java теж не потрібна: відкрийте сайт, натисніть «Грати», і гра запуститься.

В основі лежить [Horizon](https://github.com/horizon-rust/horizon), реалізація гри на Rust, зібрана для вебу. Гра працює на вашому комп’ютері й використовує вашу відеокарту, браузер лише запускає її.

> 🧪 **Це перша бета-версія.** Час від часу щось ламатиметься. Якщо ви зіткнулися з проблемою, надішліть, будь ласка, лог (як це зробити, описано нижче), це дуже допомагає.

### 🚀 Як почати

1. Встановіть **лаунчер Horizon**, увійдіть в акаунт Microsoft, на якому придбано Minecraft: Java Edition, і натисніть **«Підготувати»** біля потрібної збірки. Так підтверджується, що гра належить вам.
2. Відкрийте Astris і натисніть **«Грати»**. Під час першого запуску він попросить файли гри:
   - **З цього комп’ютера**: виберіть підготовлену теку або ZIP-архів із нею.
   - **Онлайн-встановлення**: завантажте їх через мережу зі свого комп’ютера чи NAS.
3. Копіювання триває близько пів хвилини. Після цього тека більше не потрібна, усе зберігається в браузері.

### 💻 Системні вимоги

- Актуальний браузер на рушії Chromium, наприклад **Chrome, Edge або Brave**. Ми тестуємо лише на Chromium, тому за роботу в інших браузерах не ручаємося.
- Відеокарта, яку браузер дозволяє використовувати грі (WebGPU).
- Не менше 4 ГБ оперативної пам’яті. На слабких ноутбуках краще зменшити дальність прорисовки.
- На **Linux** WebGPU треба увімкнути вручну: увімкніть `Unsafe WebGPU Support` і `Vulkan` у `chrome://flags` (або `brave://flags`) і перезапустіть браузер.

### 🔒 Усе зберігається у вас

Astris не має серверної частини. Файли гри, світи, налаштування й логи зберігаються в сховищі браузера на вашому пристрої, і сайт нікуди їх не надсилає. Акаунтів і аналітики немає. Зі сторонніх адрес сайт завантажує лише шрифти (з Google Fonts) і, якщо ви користуєтеся онлайн-встановленням, файли гри з адреси, яку ви вкажете.

### 🐛 Відомі проблеми

- **Браузер може не дати грі доступ до відеокарти.** WebGPU буває вимкнено, або браузер переходить на відтворення процесором, а цього для гри замало. У такому разі гра сама підкаже, що ввімкнути. На Linux майже завжди допомагають прапорці, описані вище.
- **На ноутбуках із двома відеокартами** гра може запуститися на вбудованій. Вона працюватиме, але повільніше. Це залежить від налаштувань системи, а не від сайту.
- **Надто велика дальність прорисовки може призвести до вильоту вкладки.** Радимо ставити не більше 12 чанків. 64-бітна збірка («Налаштування → Експерименти») дозволяє більше, але вона менше перевірена й може спричинити інші проблеми.
- **Перший вхід у великий світ може зайняти час**, бо світ довантажується навколо вас поступово.
- **Мережевої гри поки немає.** Гру разом заплановано в одній із наступних версій.

### 📝 Як повідомити про проблему

Натисніть у грі **Ctrl+Shift+L**, потім **Save**: це і є лог. Логи всіх запусків також зберігаються в лаунчері, у розділі **«Налаштування → Логи»**. Додайте лог і опишіть, що ви робили, коли виникла проблема.

### ⚖️ Ліцензія

Код Astris і Horizon поширюється за ліцензією MIT. Текстури, звуки й дані гри не входять до Astris: вони беруться з вашої копії гри й зберігаються у вашому браузері. Astris не пов’язаний із Mojang Studios і Microsoft. Minecraft є торговельною маркою Mojang Synergies AB.
