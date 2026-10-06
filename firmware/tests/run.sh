#!/bin/sh
# Собирает симулятор и прогоняет все проверки. Результат: PASS/FAIL и tests/RESULTS.txt.
#   ./run.sh          полный прогон (несколько минут)
#   ./run.sh --quick  сокращённый перебор моментов остановки
set -eu
cd "$(dirname "$0")"
./build_host.sh
exec node summary.cjs "$@"
