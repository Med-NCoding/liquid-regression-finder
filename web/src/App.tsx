import { BrowserRouter, Link, Route, Routes } from "react-router-dom";
import { ComparisonResultPage } from "./pages/ComparisonResultPage";
import { SubmissionPage } from "./pages/SubmissionPage";

export function AppRoutes() {
  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="site-header-inner">
          <Link to="/" className="brand-link">
            <span>Liquid Regression Finder</span>
            <span className="brand-badge">sale_badge</span>
          </Link>
          <nav className="site-nav" aria-label="Primary navigation">
            <Link to="/" className="nav-link">
              New Comparison
            </Link>
          </nav>
        </div>
      </header>
      <main className="main-content">
        <Routes>
          <Route path="/" element={<SubmissionPage />} />
          <Route path="/comparisons/:id" element={<ComparisonResultPage />} />
          <Route
            path="*"
            element={
              <section className="card">
                <h1>Page Not Found</h1>
                <p>The requested route does not exist.</p>
                <Link to="/" className="btn btn-primary">
                  Back to Comparison Form
                </Link>
              </section>
            }
          />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
