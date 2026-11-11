import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { NativeSelect, NativeSelectOption } from "./ui/native-select";
export type Theme = "light" | "dark" | "system";
const key = "tetraboard:admin-theme:v1";
function readTheme(): Theme {
  try {
    const value = localStorage.getItem(key);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}
const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void } | null>(null);
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "system" ? media.matches : theme === "dark";
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.classList.toggle("light", !dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === key || event.key === null) setTheme(readTheme());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  return (
    <ThemeContext.Provider
      value={{
        theme,
        setTheme: (value) => {
          setTheme(value);
          try {
            localStorage.setItem(key, value);
          } catch {
            /* 保存できない場合も、現在の画面の選択は反映します。 */
          }
        },
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}
export function ThemeSelect() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("ThemeProvider is required");
  return (
    <label className="flex flex-col gap-2 text-xs text-muted-foreground">
      表示テーマ
      <NativeSelect
        aria-label="表示テーマ"
        className="w-full"
        value={value.theme}
        onChange={(e) => value.setTheme(e.target.value as Theme)}
      >
        <NativeSelectOption value="light">ライト</NativeSelectOption>
        <NativeSelectOption value="dark">ダーク</NativeSelectOption>
        <NativeSelectOption value="system">OS設定に合わせる</NativeSelectOption>
      </NativeSelect>
    </label>
  );
}
