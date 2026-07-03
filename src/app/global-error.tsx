"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="ko">
      <body style={{ background: "#0b0e11", color: "#eaecef", fontFamily: "system-ui, sans-serif", margin: 0 }}>
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ textAlign: "center", maxWidth: 420 }}>
            <div style={{ color: "#f6465d", fontSize: 72, fontWeight: 700, lineHeight: 1, letterSpacing: "-0.02em" }}>
              FATAL
            </div>
            <h1 style={{ fontSize: 18, fontWeight: 600, marginTop: 16 }}>
              Application error
            </h1>
            <p style={{ fontSize: 13, color: "#848e9c", marginTop: 8 }}>
              The application failed to load. Please reload the page.
            </p>
            {error?.digest && (
              <p style={{ fontSize: 11, color: "#5e6673", marginTop: 8 }}>ref: {error.digest}</p>
            )}
            <button
              onClick={reset}
              style={{
                marginTop: 20,
                height: 36,
                padding: "0 16px",
                background: "#fcd535",
                color: "#0b0e11",
                border: 0,
                fontSize: 13,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Reload
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
