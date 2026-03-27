import "./globals.css";

export const metadata = {
  title: "AnonKonnect",
  description: "Premium realtime chat, region-aware matching, and gated rooms.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
