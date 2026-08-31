<div align="center">

<sub>
<a href="README.md">English</a> &nbsp;·&nbsp; <a href="README.zh-CN.md">中文</a> &nbsp;·&nbsp; <b>Русский</b>
</sub>

</div>

---

# rlm.pi PI plugin

> pi-rlm — большие контексты на дешёвых моделях: рекурсивная языковая модель (RLM) для Pi

## Установка

```bash
pi install npm:@hicaru/pi-rlm
```

Чтобы удалить позже:

```bash
pi uninstall npm:@hicaru/pi-rlm
```

Затем выполните `/reload` или перезапустите Pi — `/rlm`, `/rlm-config` и `/rlm-stop` появятся в разделе **[Extensions]**. Переключение — `Ctrl+Shift+R` или `/rlm`.

<p align="center">
  <img src="https://github.com/openzebra/rlm.pi/blob/master/assets/hero.png?raw=true" width="100%" alt="rlm.pi — результаты OOLONG">
</p>

## Что такое pi-rlm?

Плагин, который превращает сессию Pi в **рекурсивную языковую модель (RLM)**: вместо того чтобы заталкивать огромный документ в промпт, контекст живёт в Python REPL, а ваша лучшая модель им управляет — ищет, декомпозирует и делегирует чтения дешёвым worker-моделям, рекурсивно. Та же сессия Pi, те же инструменты, те же ключи — включите `/rlm` и вперёд. По методу [RLM paper](https://arxiv.org/abs/2512.24601); подробности — в разделе **Как это работает**.

## Бенчмарки

**OOLONG (oolong-synth)** — paper-tier сюит длинного контекста; последний журнал каждой модели, цена за задачу из реального `costUsd` (старые журналы оценены по прайс-листу OpenRouter):

| Модель | Счёт | Цена/задача |
|--------|------|-------------|
| `qwen/qwen3.8-27b` | **100%** | $0.0127 |
| `google/gemma-3-27b-it` | 83.3% | $0.0013 |
| `qwen/qwen3-30b-a3b-instruct-2507` | 66.7% | $0.0009 |
| `mistralai/mistral-small-3.2-24b-instruct` | 66.7% | $0.0025 |

Lite-сьют — `needle` (поиск игл в куче), `codeqa` (вопросы по коду), `coding` (задача-фикс; 7 задач × 2 прохода на модель, детерминированные грейдеры, без LLM-судьи):

| Модель | Счёт | Точность |
|--------|------|----------|
| `qwen/qwen3-30b-a3b-instruct-2507` | **14/14** | **100%** |
| `google/gemma-3-27b-it` | 12/14 | 86% |
| `mistralai/mistral-small-3.2-24b-instruct` | 12/14 | 86% |

Построчные результаты (correct, recall, latency, токены, цена) — в
`bench/runs/*.jsonl`, одна JSONL-строка на задачу.

### Как запустить

```bash
export OPENROUTER_API_KEY=sk-or-...        # обязателен — ключи ходят только через env

bun run bench                              # lite-сьют: needle + codeqa + coding
bun run bench --suite needle --limit 1     # один сьют, первая задача
bun run bench --model openrouter/qwen/qwen3-30b-a3b-instruct-2507
bun run bench --list                       # показать задачи, без движка и ключа
bun run bench --suite paper                # paper-сьют: s_niah, oolong, browsecomp, codeqa_lb (скачивает датасеты)
```

Сьюты: `all` (lite, по умолчанию) · `needle` · `codeqa` · `coding` · `paper` · `s_niah` ·
`oolong` · `browsecomp` · `codeqa_lb`.

## Как это работает

```
pi process (TypeScript)
 ├─ /rlm  ──► движок управляет SMART (корневой) моделью пошагово (пишет ```repl``` Python)
 │             │  каждый шаг: парсинг repl-блоков ──► запуск в песочнице ──► возврат stdout
 │             ▼
 ├─ bridge ── llm_query / llm_query_batched ──► WORKER модель (serverless, in-process)
 │            rlm_query ──► рекурсивный дочерний RLM (с собственной песочницей), с ограничением глубины
 ├─ AgentTree ──► живое дерево агентов/субагентов над редактором (роли, глубина, стоимость, токены)
 └─ PythonSandbox ── `python3 worker.py` ──[JSONL over stdio, bidirectional]── постоянный REPL
```

- **Никаких серверов, сокетов или Docker.** Единственным внешним процессом является локальная песочница `python3`. Когда код в песочнице вызывает `llm_query`, worker пишет запрос в stdout и блокируется на stdin; Pi обрабатывает его внутри своего процесса и записывает ответ обратно. **API-ключи провайдеров никогда не попадают в песочницу.**
- Песочница предоставляет `context`, `llm_query`, `llm_query_batched`, `rlm_query`,
  `rlm_query_batched`, `SHOW_VARS()`, `ask_user_question()` и словарь `answer`.
  Модель отправляет окончательный результат, устанавливая `answer["ready"] = True`.

## Установка из исходников (для разработки)

`pi-rlm` — это пакет Pi. Pi предоставляет peer-зависимости `@earendil-works/pi-*` и `typebox`; **не** устанавливайте их отдельную копию в этот пакет. Требуется `python3` в `PATH` (только стандартная библиотека).

Локальная установка при разработке:

```bash
pi install /path/to/this-repo/pi-plugin/rlm
```

> **Установка через Git** требует, чтобы манифест пакета находился в корне устанавливаемого репозитория. Для поддиректорий монорепозитория, таких как эта, предпочтительнее использовать локальный путь, как указано выше.

Если вы ранее копировали папку расширения напрямую, удалите ее, чтобы она не перекрывала пакет:

```bash
rm -rf ~/.pi/agent/extensions/rlm
```

Затем выполните `/reload` или перезапустите Pi. Убедитесь с помощью `pi list`, что пакет появился в `settings.packages`, и проверьте, что `/rlm`, `/rlm-config` и `/rlm-stop` отображаются в разделе **[Extensions]**.

## Команды

| Команда | Горячая клавиша | Описание |
|---|---|---|
| `/rlm` | `Ctrl+Shift+R` | Переключить постоянный режим RLM (направлять обычные промпты через движок RLM) |
| `/rlm-stop` | | Прервать текущий запуск |
| `/rlm-config` | | Выбрать smart- и worker-модели и настроить параметры запуска |

Пока запуск активен, **живое дерево** отображает корневой оркестратор и каждый sub-LLM / рекурсивный дочерний элемент со статусом, моделью, стоимостью, токенами и длительностью. Окончательный ответ публикуется в чате в формате markdown; любые правки кода собираются в виде диффов и проверяются через всплывающее окно (если не включен `yolo`).

## Sandbox API

Эти функции внедряются в пространство имен Python модели внутри REPL:

| Функция | Сигнатура | Описание |
|---|---|---|
| `context` | `list[dict]` | Репозиторий, упакованный как `[{"path","content","tokens"}, ...]` — вся кодовая база |
| `llm_query` | `(prompt) -> str` | Одноразовый вызов sub-LLM (настроенная RLM LLM) |
| `llm_query_batched` | `(prompts) -> list[str]` | Параллельные вызовы sub-LLM (с ограничением пула) |
| `rlm_query` | `(prompt, paths=None) -> str` | Рекурсивный дочерний RLM со своей песочницей (с ограничением глубины). Наследует ваш `context`; `paths` сужает его по префиксу |
| `rlm_query_batched` | `(prompts, paths=None) -> list[str]` | Параллельные рекурсивные дочерние RLM с общим срезом `paths` |
| `ask_user_question` | `(questions) -> list[dict]` | Задать пользователю структурированные вопросы (только на глубине 0) |
| `SHOW_VARS` | `() -> str` | Список текущих переменных и их типов |
| `answer` | `dict` | Установите `answer["content"]=...; answer["ready"]=True` для завершения |

## Настройки (`/rlm-config`)

| Настройка | По умолчанию | Значение |
|---|---|---|
| Smart model | Активная модель Pi | корневой оркестратор |
| Worker model | Самая дешевая доступная | отвечает на `llm_query` |
| Max recursion depth | `4` | при превышении этой глубины `rlm_query` переключается на `llm_query` |
| Max iterations | `30` | количество шагов до завершения работы движка |
| Budget ceiling | нет | остановка всего дерева, когда затраты в USD превышают этот лимит |
| Max consecutive errors | `5` | остановка после N последовательных шагов с ошибками |
| REPL block timeout | `120s` | реальное время на один `repl`-блок (SIGALRM в worker) |
| Max concurrent sub-calls | `4` | размер пула для `*_batched` |
| Orchestrator addendum | вкл | инструкция «делегируй, а не решай сам» |
| Trajectory compaction | вкл (0.85) | суммаризация истории при приближении к лимиту окна контекста |
| `yolo` | выкл | применять предлагаемые правки немедленно, пропуская окно подтверждения |
| `askUserQuestion` | вкл | предоставить доступ к `ask_user_question()` для модели |

> **Примечание по параллелизму:** каждый дочерний `rlm_query` запускает собственного worker `python3` (~50–150 мс «холодного старта»). В худшем случае количество параллельных интерпретаторов ≈ `maxConcurrentSubcalls`^(depth−1); при настройках по умолчанию (глубина 4, параллелизм 4) это 4³ = 64 в патологическом случае. Лимиты бюджета и ошибок (см. выше) ограничивают общие затраты независимо от степени разветвления.

## Телеметрия и логи запусков

- **Трассировка MLflow** (`telemetry`): опционально. Установите `MLFLOW_TRACKING_URI` или настройте `trackingUri` / `experimentId` в `/rlm-config`. Корневой запуск помечается как span MLflow для корреляции трасс при возобновлении. Bearer-токен берется из переменной окружения `MLFLOW_TRACKING_TOKEN` и **никогда не сохраняется** в `rlm.json`.

## Безопасность

- **Изоляция ключей**: ключи провайдеров хранятся только в TypeScript (`AuthStorage`); песочница получает промпты и возвращает текст, но никогда не получает ключи.
- **Очистка окружения**: чувствительные переменные окружения (API-ключи, токены) удаляются перед запуском worker. Worker не может прочитать учетные данные провайдеров из `os.environ`.
- **НЕ является защищенной песочницей**: Python-worker предоставляет доступ к `__import__` и `open`. Код, написанный моделью, может импортировать сетевые модули, читать/записывать локальные файлы и писать JSON-данные протокола в stdout. Этот уровень доверяет коду корневой модели; протокол stdio изолирует ключи провайдеров и жизненный цикл процесса, а **не** ограничивает вредоносный код. Более строгая песочница (Docker, seccomp) может быть добавлена позже через настройки без изменения протокола.
- **Ограниченные встроенные функции**: запрещены `eval`/`exec`/`compile`/`input`/`globals`/`locals`; тайм-аут SIGALRM для каждого блока + родительский watchdog (SIGKILL при зависании); лимиты по бюджету / токенам / времени / количеству последовательных ошибок.
- **Доверие**: локальная установка в проект требует доверия к проекту Pi.

## Структура проекта

```
src/
  sandbox/    py/ (worker.py · guards · retrieval · tasks) · sandbox.ts · interrupts · protocol · sandbox-manager · context-file
  bridge/     model.ts (single completion) · subcall-handlers.ts (the one llm/rlm impl) · ask-user · library
  core/       engine.ts (the loop) · iteration · limits · resource-limits · answer · compaction · history · types
  prompts/    glossary (shared REPL vocabulary) · system (headless) · native · user
  text/       parsing (repl blocks) · tokens · preview
  tool/       repl-tool · repl-result · repl-render · rlm-tool · rlm-events · rlm-aggregator · subcall-store · background-tasks
  config/     defaults · settings (rlm.json persistence + validation)
  context/    native walker + anydoc document conversion + add_context
  ui/         status · model-picker · config-panel · intro · theme
  commands/   rlm · rlm-config
  mode/       rlm-mode (controller) · worker-model (cheapest pick) · native-guards
  util/       errors · concurrency · trace
test/         phase suites · native-smoke · native-mode · helpers
```

## Тесты

Среда выполнения — **Bun** (`bun install`, `bun run …` — никогда не используйте npm/pnpm/yarn).

```bash
bun run test/phase1.ts                   # sandbox: exec, persistence, key isolation, timeout kill
bun run test/phase4.ts                   # recursion depth-cap logic (no tokens)
bun run test/phase5.ts                   # live agent tree rendering (no tokens)
RLM_TEST_LIVE=1 bun run test/phase2.ts   # real llm_query through the sandbox
RLM_TEST_LIVE=1 bun run test/phase3.ts   # real end-to-end /rlm over a file context
RLM_TEST_LIVE=1 bun run test/phase4.ts   # engine solves a 20-doc needle-in-haystack
```

## Общая информация

Реализовано на основе метода из [статьи RLM](https://arxiv.org/abs/2512.24601), с нативной переработкой для Pi.

Если вы используете этот проект в своих исследованиях, пожалуйста, сошлитесь на оригинальную работу RLM:

```bibtex
@misc{zhang2026recursivelanguagemodels,
      title={Recursive Language Models},
      author={Alex L. Zhang and Tim Kraska and Omar Khattab},
      year={2026},
      eprint={2512.24601},
      archivePrefix={arXiv},
      primaryClass={cs.AI},
      url={https://arxiv.org/abs/2512.24601},
}
```
