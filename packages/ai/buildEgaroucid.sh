#!/bin/sh
set -eu

# 固定サイズの置換表を動的確保に切り替え、実行時のハッシュ設定を反映します。
sed -i 's/^#define TT_USE_STACK true$/#define TT_USE_STACK false/' src/engine/setting.hpp
grep -qx '#define TT_USE_STACK false' src/engine/setting.hpp
g++ -O2 -march=x86-64-v3 -pthread -std=c++20 -static-libstdc++ -static-libgcc \
  src/Egaroucid_for_Console.cpp -o bin/egaroucid
