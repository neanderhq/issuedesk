"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const enabled = localStorage.getItem("team-tracker-theme") === "dark";
    document.documentElement.classList.toggle("dark", enabled);
    setDark(enabled);
  }, []);

  function toggle() {
    const enabled = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", enabled);
    localStorage.setItem("team-tracker-theme", enabled ? "dark" : "light");
    setDark(enabled);
  }

  return <Button type="button" variant="outline" size="icon-sm" aria-label={`Switch to ${dark ? "light" : "dark"} theme`} onClick={toggle}>
    {dark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
  </Button>;
}
