import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "./globals.css";
import type { ReactNode } from "react";
export const metadata = { title: "Team Tracker", description: "A shared workspace for your team." };
export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en" suppressHydrationWarning><body><script dangerouslySetInnerHTML={{ __html: "try{if(localStorage.getItem('team-tracker-theme')==='dark')document.documentElement.classList.add('dark')}catch{}" }} />{children}</body></html>;
}
