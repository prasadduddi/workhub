package main

import (
	"net/url"
	"strings"
)

// Sites never imported from browser bookmarks or captured: well-known adult
// sites built in, plus the workspace's own list (Settings.BlockedSites).
// Only the domain is checked, so ordinary pages aren't caught by mistake.

var adultDomains = []string{
	"xhamster", "pornhub", "xvideos", "xnxx", "redtube", "youporn", "tube8", "spankbang", "porntrex", "eporner",
	"txxx", "hclips", "upornia", "beeg", "tnaflix", "drtuber", "sunporno", "nuvid", "motherless", "hqporner",
	"onlyfans", "fansly", "chaturbate", "stripchat", "bongacams", "cam4", "camsoda", "livejasmin", "myfreecams",
	"brazzers", "realitykings", "bangbros", "naughtyamerica", "mofos", "digitalplayground", "fakehub",
	"rule34", "e-hentai", "nhentai", "hanime", "fapello", "erome", "imagefap", "literotica", "adultfriendfinder",
	"thisvid", "porn300", "pornone", "4tube", "fuq", "ixxx", "porndig", "vporn", "anysex", "sexvid", "xozilla",
	"redwap", "youjizz", "xtube", "keezmovies", "slutload", "empflix", "tubegalore", "xtapes", "3movs", "daftsex", "sxyprn",
	"xmoviesforyou", "fapster", "xbabe", "ashemaletube", "shemale", "tranny", "gaytube", "manyvids", "clips4sale", "iwara",
	"luscious", "hentaihaven", "hitomi", "pururin", "javhd", "javlibrary", "jable", "missav", "supjav", "avgle", "xhamsterlive",
	"camster", "flirt4free", "streamate", "imlive", "jerkmate", "adulttime", "pornpics", "sex", "xart", "metart", "playboy",
	"hustler", "penthouse", "kink", "bdsm", "fetlife", "redgifs", "gfycatporn", "scrolller", "motherless", "heavy-r", "efukt",
}

var adultWords = []string{"porn", "xxx", "hentai", "nsfw", "camgirl", "escort"}

func siteHost(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Hostname() == "" {
		return ""
	}
	return strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")
}

// blockedURL reports whether a link must never be imported or captured.
func blockedURL(raw string, own []string) bool {
	h := siteHost(raw)
	if h == "" {
		return false
	}
	labels := strings.Split(h, ".")
	for _, d := range adultDomains {
		for _, l := range labels {
			if l == d {
				return true
			}
		}
	}
	for _, w := range adultWords {
		if strings.Contains(h, w) {
			return true
		}
	}
	for _, b := range own {
		b = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(b)), "www.")
		b = strings.TrimPrefix(strings.TrimPrefix(b, "https://"), "http://")
		b = strings.TrimSuffix(b, "/")
		if b == "" {
			continue
		}
		if h == b || strings.HasSuffix(h, "."+b) || (!strings.Contains(b, ".") && strings.Contains(h, b)) {
			return true
		}
	}
	return false
}
