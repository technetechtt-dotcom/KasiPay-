import { useCallback } from 'react';
import type { Language } from '../types';

const translations = {
  en: {
    greeting: {
      morning: 'Good morning',
      afternoon: 'Good afternoon',
      evening: 'Good evening',
    },
    nav: {
      home: 'Home',
      services: 'Services',
      shop: 'Shop',
      history: 'History',
      more: 'More',
    },
    actions: {
      sendMoney: 'Send Money',
      receiveMoney: 'Receive Money',
      newSale: 'New Sale',
      checkStock: 'Check Stock',
      viewAll: 'View All',
      calculator: 'Calculator',
    },
    home: {
      walletBalance: 'Shop Wallet Balance',
      todaysSales: "Today's Sales",
      todaysProfit: "Today's Profit",
      transfers: 'Transfers',
      recentActivity: 'Recent Activity',
    },
    shop: {
      title: 'Shop Management',
      newSale: 'Make a sale',
      addProduct: 'Add product',
      inventory: 'Inventory',
      expenses: 'Expenses',
      reports: 'Reports',
      lowStock: 'Low stock',
    },
    inventory: {
      title: 'Inventory',
      stockValue: 'Stock value',
      addProduct: 'Add product',
      reorder: 'Reorder',
      outOfStock: 'Out of stock',
      inStock: 'In stock',
    },
    settings: {
      title: 'Settings',
      profile: 'Business profile',
      pin: 'Change PIN',
      language: 'Language',
      diagnostics: 'Diagnostics',
      closeAccount: 'Close account',
      kyc: 'KYC status',
      accountTier: 'Account tier',
      save: 'Save',
      cancel: 'Cancel',
      help: 'Help & Support',
    },
    more: {
      title: 'More',
      shopManagement: 'Shop Management',
      communityServices: 'Community & Services',
      workspaceWallet: 'Wallet mode',
      workspaceMerchant: 'Merchant mode',
      signOut: 'Sign out',
    },
    common: {
      back: 'Back',
      save: 'Save',
      cancel: 'Cancel',
      delete: 'Delete',
      confirm: 'Confirm',
      loading: 'Loading…',
      empty: 'Nothing here yet',
      error: 'Something went wrong',
    },
  },
  zu: {
    greeting: {
      morning: 'Sawubona ekuseni',
      afternoon: 'Sawubona ntambama',
      evening: 'Sawubona kusihlwa',
    },
    nav: {
      home: 'Ekhaya',
      services: 'Imisebenzi',
      shop: 'Isitolo',
      history: 'Umlando',
      more: 'Okunye',
    },
    actions: {
      sendMoney: 'Thumela Imali',
      receiveMoney: 'Yamukela Imali',
      newSale: 'Ukuthengisa Okusha',
      checkStock: 'Hlola Isitoko',
      viewAll: 'Buka Konke',
      calculator: 'Isibali',
    },
    home: {
      walletBalance: 'Ibhalansi Yesikhwama',
      todaysSales: 'Ukuthengisa Kwanamuhla',
      todaysProfit: 'Inzuzo Yanamuhla',
      transfers: 'Okudlulisiwe',
      recentActivity: 'Imisebenzi Yakamuva',
    },
    shop: {
      title: 'Ukulawulwa Kwesitolo',
      newSale: 'Yenza ukuthengisa',
      addProduct: 'Engeza umkhiqizo',
      inventory: 'Isitoko',
      expenses: 'Izindleko',
      reports: 'Imibiko',
      lowStock: 'Isitoko esiphansi',
    },
    inventory: {
      title: 'Isitoko',
      stockValue: 'Inani lesitoko',
      addProduct: 'Engeza umkhiqizo',
      reorder: 'Phinda ucele',
      outOfStock: 'Aphelile',
      inStock: 'Asekhona',
    },
    settings: {
      title: 'Izilungiselelo',
      profile: 'Iphrofayela yebhizinisi',
      pin: 'Shintsha i-PIN',
      language: 'Ulimi',
      diagnostics: 'Ukuhlola',
      closeAccount: 'Vala i-akhawunti',
      kyc: 'Isimo se-KYC',
      accountTier: 'Izinga le-akhawunti',
      save: 'Londoloza',
      cancel: 'Khansela',
      help: 'Usizo nokwesekwa',
    },
    more: {
      title: 'Okunye',
      shopManagement: 'Ukuphathwa kwesitolo',
      communityServices: 'Umphakathi nezinkonzo',
      workspaceWallet: 'Imodi yesikhwama',
      workspaceMerchant: 'Imodi yomthengisi',
      signOut: 'Phuma',
    },
    common: {
      back: 'Emuva',
      save: 'Londoloza',
      cancel: 'Khansela',
      delete: 'Susa',
      confirm: 'Qinisekisa',
      loading: 'Iyalayisha…',
      empty: 'Akukho lutho okwamanje',
      error: 'Kukhona okungahambanga kahle',
    },
  },
  xh: {
    greeting: {
      morning: 'Molo kusasa',
      afternoon: 'Molo emini',
      evening: 'Molo ngokuhlwa',
    },
    nav: {
      home: 'Ekhaya',
      services: 'Iinkonzo',
      shop: 'Ivenkile',
      history: 'Imbali',
      more: 'Ngaphezulu',
    },
    actions: {
      sendMoney: 'Thumela Imali',
      receiveMoney: 'Yamkela Imali',
      newSale: 'Intengiso Entsha',
      checkStock: 'Jonga Isitoko',
      viewAll: 'Jonga Konke',
      calculator: 'Isibali',
    },
    home: {
      walletBalance: 'Ibhalansi yeSipaji',
      todaysSales: 'Iintengiso Zanamhlanje',
      todaysProfit: 'Inzuzo Yanamhlanje',
      transfers: 'Uthumelo',
      recentActivity: 'Imisebenzi Yamva Nje',
    },
    shop: {
      title: 'Ulawulo Lwevenkile',
      newSale: 'Yenza intengiso',
      addProduct: 'Yongeza imveliso',
      inventory: 'Isitoko',
      expenses: 'Iindleko',
      reports: 'Iingxelo',
      lowStock: 'Isitoko esiphantsi',
    },
    inventory: {
      title: 'Isitoko',
      stockValue: 'Ixabiso lesitoko',
      addProduct: 'Yongeza imveliso',
      reorder: 'Phinda ucele',
      outOfStock: 'Aphelile',
      inStock: 'Asekhona',
    },
    settings: {
      title: 'Iisetingi',
      profile: 'Iprofayile yeshishini',
      pin: 'Tshintsha i-PIN',
      language: 'Ulwimi',
      diagnostics: 'Uhlolo',
      closeAccount: 'Vala iakhawunti',
      kyc: 'Imeko ye-KYC',
      accountTier: 'Inqanaba leakhawunti',
      save: 'Gcina',
      cancel: 'Rhoxisa',
      help: 'Uncedo & inkxaso',
    },
    more: {
      title: 'Ngaphezulu',
      shopManagement: 'Ulawulo lwevenkile',
      communityServices: 'Uluntu neenkonzo',
      workspaceWallet: 'Imowudi yesipaji',
      workspaceMerchant: 'Imowudi yomthengisi',
      signOut: 'Phuma',
    },
    common: {
      back: 'Emva',
      save: 'Gcina',
      cancel: 'Rhoxisa',
      delete: 'Cima',
      confirm: 'Qinisekisa',
      loading: 'Iyalayisha…',
      empty: 'Akukho nto okwangoku',
      error: 'Kukho into engahambanga kakuhle',
    },
  },
};

type TranslationTree = {
  [key: string]: string | TranslationTree;
};

export function useTranslations(lang: Language) {
  const t = useCallback(
    (path: string) => {
      const keys = path.split('.');
      let current: string | TranslationTree = translations[lang] as TranslationTree;

      for (const key of keys) {
        if (typeof current !== 'object' || current === null || !(key in current)) {
          // Fallback to English if translation is missing
          let fallback: string | TranslationTree = translations['en'] as TranslationTree;
          for (const k of keys) {
            if (typeof fallback !== 'object' || fallback === null || !(k in fallback))
              return path;
            fallback = fallback[k] as string | TranslationTree;
          }
          return typeof fallback === 'string' ? fallback : path;
        }
        current = current[key] as string | TranslationTree;
      }

      return typeof current === 'string' ? current : path;
    },
    [lang]
  );

  return { t };
}