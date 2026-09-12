import { useI18n } from '../lib/i18n';
import React, { useState, useEffect } from 'react';
import { WifiOff } from 'lucide-react';

export const OfflineIndicator: React.FC = () => {
  const { t } = useI18n();
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

  return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (isOnline) return null;

  return (
    <div 
      id="offline-indicator-banner"
      className="fixed bottom-4 start-4 z-50 flex items-center gap-2 rounded-md bg-amber-950 border border-amber-800 px-3 py-1.5 text-xs font-medium text-amber-200 shadow-lg"
      role="status"
    >
      <WifiOff className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
      <span>{t('offline.banner')}</span>
    </div>
  );
};
