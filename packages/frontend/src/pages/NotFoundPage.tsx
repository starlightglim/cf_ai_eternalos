// 404 Not Found Page - Classic Mac OS styled
import { Link } from 'react-router-dom';
import { useDocumentMeta } from '../hooks/useDocumentMeta';
import styles from './AuthPage.module.css';

export function NotFoundPage() {
  useDocumentMeta({ title: 'Page Not Found - EternalOS' });

  return (
    <div className={styles.authContainer}>
      <div className={styles.authWindow}>
        <div className={styles.titleBar}>
          <span className={styles.titleText}>Error</span>
        </div>
        <div className={styles.content}>
          <div className={styles.logo}>
            <span className={styles.logoText}>404</span>
          </div>
          <div className={styles.instructions}>
            The page you are looking for could not be found.
            It may have been moved or no longer exists.
          </div>
          <div className={styles.linkSection}>
            <Link to="/" className={styles.link}>Return to Home</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
