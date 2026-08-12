export const metadata = {
  title: 'Touchline — post generator',
  description: 'Generate and review daily European football carousels',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        {/* Anton and Barlow Condensed are the template's display faces.
            capture.js waits for these to load before making any PNG. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Anton&family=Barlow+Condensed:wght@600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body style={{ margin: 0, background: '#101314' }}>{children}</body>
    </html>
  );
}
