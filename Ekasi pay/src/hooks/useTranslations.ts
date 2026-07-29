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
  af: {
    greeting: {
      morning: 'Goeie more',
      afternoon: 'Goeie middag',
      evening: 'Goeie aand',
    },
    nav: {
      home: 'Tuis',
      services: 'Dienste',
      shop: 'Winkel',
      history: 'Geskiedenis',
      more: 'Meer',
    },
    actions: {
      sendMoney: 'Stuur geld',
      receiveMoney: 'Ontvang geld',
      newSale: 'Nuwe verkoop',
      checkStock: 'Kontroleer voorraad',
      viewAll: 'Sien alles',
      calculator: 'Sakrekenaar',
    },
    home: {
      walletBalance: 'Winkel beursie-saldo',
      todaysSales: 'Vandag se verkope',
      todaysProfit: 'Vandag se wins',
      transfers: 'Oordragte',
      recentActivity: 'Onlangse aktiwiteit',
    },
    shop: {
      title: 'Winkelbestuur',
      newSale: 'Maak ’n verkoop',
      addProduct: 'Voeg produk by',
      inventory: 'Voorraad',
      expenses: 'Uitgawes',
      reports: 'Verslae',
      lowStock: 'Lae voorraad',
    },
    inventory: {
      title: 'Voorraad',
      stockValue: 'Voorraadwaarde',
      addProduct: 'Voeg produk by',
      reorder: 'Herbestel',
      outOfStock: 'Uit voorraad',
      inStock: 'In voorraad',
    },
    settings: {
      title: 'Instellings',
      profile: 'Besigheidsprofiel',
      pin: 'Verander PIN',
      language: 'Taal',
      diagnostics: 'Diagnostiek',
      closeAccount: 'Sluit rekening',
      kyc: 'KYC-status',
      accountTier: 'Rekeningvlak',
      save: 'Stoor',
      cancel: 'Kanselleer',
      help: 'Hulp & ondersteuning',
    },
    more: {
      title: 'Meer',
      shopManagement: 'Winkelbestuur',
      communityServices: 'Gemeenskap & dienste',
      workspaceWallet: 'Beursie-modus',
      workspaceMerchant: 'Handelaar-modus',
      signOut: 'Teken uit',
    },
    common: {
      back: 'Terug',
      save: 'Stoor',
      cancel: 'Kanselleer',
      delete: 'Skrap',
      confirm: 'Bevestig',
      loading: 'Laai…',
      empty: 'Nog niks hier nie',
      error: 'Iets het verkeerd geloop',
    },
  },
  tn: {
    greeting: {
      morning: 'Dumela mo mosong',
      afternoon: 'Dumela motshegare',
      evening: 'Dumela maabane',
    },
    nav: {
      home: 'Gae',
      services: 'Ditirelo',
      shop: 'Lebenkele',
      history: 'Histori',
      more: 'Go feta',
    },
    actions: {
      sendMoney: 'Romela madi',
      receiveMoney: 'Amogela madi',
      newSale: 'Thekiso e ntšhwa',
      checkStock: 'Tlhola stock',
      viewAll: 'Bona tsotlhe',
      calculator: 'Khalakhuleitha',
    },
    home: {
      walletBalance: 'Tekanyo ya wallet ya lebenkele',
      todaysSales: 'Dithekiso tsa gompieno',
      todaysProfit: 'Poelo ya gompieno',
      transfers: 'Diphetiso',
      recentActivity: 'Ditiro tsa bosheng',
    },
    shop: {
      title: 'Taolo ya lebenkele',
      newSale: 'Dira thekiso',
      addProduct: 'Oketsa setlhagiso',
      inventory: 'Stock',
      expenses: 'Ditsenye',
      reports: 'Dipego',
      lowStock: 'Stock e kwa tlase',
    },
    inventory: {
      title: 'Stock',
      stockValue: 'Boleng jwa stock',
      addProduct: 'Oketsa setlhagiso',
      reorder: 'Ordera gape',
      outOfStock: 'Ga go na stock',
      inStock: 'Go na le stock',
    },
    settings: {
      title: 'Dipeakanyo',
      profile: 'Porofaele ya kgwebo',
      pin: 'Fetola PIN',
      language: 'Puo',
      diagnostics: 'Tlhatlhobo',
      closeAccount: 'Tswala akhaonto',
      kyc: 'Maemo a KYC',
      accountTier: 'Legato la akhaonto',
      save: 'Boloka',
      cancel: 'Khansela',
      help: 'Thuso & tshegetso',
    },
    more: {
      title: 'Go feta',
      shopManagement: 'Taolo ya lebenkele',
      communityServices: 'Setšhaba & ditirelo',
      workspaceWallet: 'Mokgwa wa wallet',
      workspaceMerchant: 'Mokgwa wa morekisi',
      signOut: 'Tswa',
    },
    common: {
      back: 'Morago',
      save: 'Boloka',
      cancel: 'Khansela',
      delete: 'Phimola',
      confirm: 'Netefatsa',
      loading: 'E a laisa…',
      empty: 'Ga go na sepe jaanong',
      error: 'Go na le phoso',
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