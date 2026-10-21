import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EMIT Load Order Portal",
  description: "EMIT shipment portal for Select Transport Partners",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("emit-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;else if(window.matchMedia("(prefers-color-scheme: light)").matches)document.documentElement.dataset.theme="light";}catch(e){}`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
