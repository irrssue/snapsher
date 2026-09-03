/**
 * Passwords that are refused outright, however long they are.
 *
 * config.ts's lockout notes end by admitting that a distributed campaign is not
 * meaningfully slowed by anything in this process — `perAccount` can't refuse
 * outright without becoming a remote denial of service against any account
 * whose address is known, and `perIp` is per-source by construction. What
 * actually bounds a botnet is the password, which is why the rules are enforced
 * at sign-up rather than offered as advice. An eight-character minimum with no
 * denylist did not enforce much: `password`, `12345678`, `qwertyui`,
 * `iloveyou` and `letmein1` all passed, and between them they are a
 * double-digit percentage of every list that has ever leaked.
 *
 * Inline rather than a package. The homeserver deploy is `git pull` +
 * `npm run build` + `pm2 restart` and never runs `npm install`, so a new
 * dependency builds on the laptop and crashes the process on boot over there —
 * the same constraint that makes email a raw `fetch` and image checks a
 * hand-written header walk. A few hundred entries is not a substitute for zxcvbn
 * and isn't trying to be; it is the head of the distribution, which is where
 * essentially all of the guessing happens.
 *
 * Entries are lowercase and matched against a lowercased candidate, because
 * `Password1` is the same guess as `password1` to anyone running a list — every
 * cracking tool applies case rules for free. Nothing shorter than
 * `MIN_PASSWORD_LENGTH` needs to be here (those are already refused), but a few
 * are kept anyway so this list stays legible as "the common ones" rather than
 * as a set of rules about length.
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  // The perennial top of every leak, plus their obvious decorations.
  "password", "password1", "password12", "password123", "password1234",
  "password12345", "password!", "password@", "password@123", "passw0rd",
  "passw0rd1", "passw0rd123", "p@ssword", "p@ssw0rd", "p@ssword1",
  "p@ssw0rd1", "p@ssw0rd123", "passwort", "contrasena", "motdepasse",
  "mypassword", "newpassword", "thepassword", "passwords", "password0",
  "password2", "password3", "password7", "password9", "password11",
  "password99", "password2020", "password2021", "password2022",
  "password2023", "password2024", "password2025",

  // Straight runs off the number row.
  "12345678", "123456789", "1234567890", "12345678910", "123456789012",
  "1234567891", "1234567899", "0123456789", "987654321", "9876543210",
  "87654321", "76543210", "11111111", "22222222", "33333333", "44444444",
  "55555555", "66666666", "77777777", "88888888", "99999999", "00000000",
  "12341234", "12121212", "11223344", "12344321", "10101010", "13131313",
  "69696969", "12332112", "112233445", "1122334455", "123123123",
  "321321321", "159753", "1qaz2wsx", "1qaz2wsx3edc", "1q2w3e4r",
  "1q2w3e4r5t", "q1w2e3r4", "q1w2e3r4t5", "1qazxsw2", "zaq12wsx",
  "qazwsx123", "asdf1234", "1234qwer", "qwer1234", "qwerty123",
  "qwerty1234", "qwerty12345", "qwertyui", "qwertyuiop", "qwerty12",
  "qwerty007", "qwertyuiop123", "azertyuiop", "asdfghjkl", "asdfghjk",
  "zxcvbnm1", "zxcvbnm123", "qwaszx123", "poiuytrewq", "lkjhgfdsa",
  "mnbvcxz1", "qweasdzxc", "qweasd123", "1qwerty", "qwerty1q",

  // Names, endearments and the sentences people think are original.
  "iloveyou", "iloveyou1", "iloveyou2", "iloveyou123", "iloveu123",
  "loveyou123", "ilovehim", "ilovher", "iloveher", "ilovemymom",
  "ilovemydad", "ilovegod", "iloveyousomuch", "loveislove", "princess1",
  "princess12", "princess123", "sunshine1", "sunshine123", "butterfly1",
  "butterfly123", "chocolate1", "chocolate123", "sweetie1", "babygirl1",
  "babygirl123", "babyboy123", "mysweetheart", "sweetheart1", "darling1",
  "beautiful1", "beautiful123", "gorgeous1", "angel123", "angelbaby",
  "cutiepie1", "honeybee1", "kisses123", "letmein", "letmein1",
  "letmein123", "letmein2", "trustno1", "trustnoone", "whatever1",
  "whatever123",

  // Fandom, brands and pop culture — the single largest category after runs.
  "superman1", "superman123", "batman123", "spiderman1", "spiderman123",
  "starwars1", "starwars123", "pokemon1", "pokemon123", "minecraft1",
  "minecraft123", "fortnite1", "fortnite123", "roblox123", "harrypotter1",
  "harrypotter", "hogwarts1", "gryffindor", "slytherin1", "gandalf1",
  "skywalker1", "darthvader", "chewbacca1", "wolverine1", "deadpool1",
  "ironman123", "captainamerica", "thor12345", "avengers1", "naruto123",
  "sasuke123", "onepiece1", "dragonball", "dragonballz", "goku1234",
  "pikachu1", "pikachu123", "charizard1", "mariobros1", "supermario1",
  "zeldalink1", "callofduty1", "counterstrike", "leagueoflegends",
  "overwatch1", "valorant123", "amongus123", "playstation1", "xbox360live",
  "nintendo64", "gamer1234", "gaming123", "twitch123",

  // Sports, teams and clubs.
  "football1", "football12", "football123", "baseball1", "baseball123",
  "basketball1", "basketball", "liverpool1", "liverpoolfc", "chelsea1",
  "chelseafc", "arsenal1", "arsenalfc", "manutd123", "manchester1",
  "manchesterunited", "barcelona1", "realmadrid1", "juventus1",
  "bayern123", "cricket123", "hockey123", "soccer123", "rangers1",
  "celtic1888", "yankees1", "cowboys1", "steelers1", "packers1",
  "lakers123", "chicago1", "tennis123", "golf1234", "boxing123",

  // Animals, food, weather — the "concrete noun plus digit" shape.
  "monkey123", "monkey12", "dragon123", "dragon12", "tigger123",
  "shadow123", "pepper123", "cookie123", "peanut123", "buster123",
  "charlie1", "charlie123", "bailey123", "maggie123", "molly123",
  "lucky123", "rocky123", "bandit123", "harley123", "jasper123",
  "chicken1", "chicken123", "cheese123", "banana123", "orange123",
  "apple123", "pizza123", "burger123", "coffee123", "whiskey1",
  "guinness1", "corona123", "rainbow1", "rainbow123", "thunder1",
  "lightning1", "hurricane1", "snowflake1", "summer123", "winter123",
  "spring123", "autumn123",

  // Cars, motorbikes, machinery.
  "ferrari1", "ferrari123", "porsche1", "porsche911", "corvette1",
  "mustang1", "mustang123", "camaro123", "harleydavidson", "yamaha123",
  "kawasaki1", "toyota123", "honda123", "nissan123", "subaru123",
  "mercedes1", "mercedes123", "bmw12345", "audia4321", "volkswagen1",

  // Profanity and the "nobody will guess this" family.
  "fuckyou1", "fuckyou123", "fuckoff123", "fuckthis1", "bullshit1",
  "asshole1", "bastard1", "bitches1", "whatthefuck", "gtfo1234",
  "nopassword", "nothing123", "secret123", "secretpassword",
  "mysecret1", "hiddenpassword", "topsecret1", "classified1",
  "confidential", "private123", "personal1", "dontguess1",
  "youllneverguess", "guessthis1", "cantguessme", "notmypassword",
  "changeme", "changeme1", "changeme123", "changethis", "temppassword",
  "temporary1", "defaultpassword", "welcome123", "welcome1", "welcome12",
  "welcometo1", "hello1234", "hello12345", "helloworld", "helloworld1",

  // Administrative and default-credential shapes. Not reachable from the
  // sign-up form's own vocabulary, but they are the first thing any credential
  // stuffer tries and they cost nothing to refuse.
  "administrator", "admin1234", "admin12345", "administrator1", "adminadmin",
  "admin@123", "root1234", "rootroot", "toor1234", "superuser1",
  "sysadmin1", "operator1", "guest1234", "testtest", "test1234",
  "test12345", "testing123", "testuser1", "demo1234", "demo12345",
  "sample123", "example123", "default123", "user1234", "user12345",
  "username1", "login1234", "access123", "master123", "manager1",
  "service123", "support123", "database1", "server123", "backup123",
  "internet1", "computer1", "computer123", "windows123", "linux123",
  "android1", "iphone123", "samsung1", "google123", "facebook1",
  "facebook123", "instagram1", "instagram123", "snapchat1", "snapsher1",
  "snapsher123", "twitter123", "youtube123", "tiktok123", "whatsapp1",

  // Keyboard shapes and leetspeak that look strong and aren't.
  "!qaz2wsx", "p@55w0rd", "l3tm31n1", "h4ck3r123", "n0p3n0p3",
  "s3cr3t123", "tr0ub4dor", "correcthorse", "correcthorsebattery",
  "abcd1234", "abc12345", "abcdefgh", "abcdefg1", "abcd123456",
  "aaaaaaaa", "aaaa1111", "asdasd123", "qweqwe123", "zxczxc123",
  "123abc123", "a1b2c3d4", "a1234567", "1a2b3c4d", "aa123456",
  "abc123456", "123qweasd", "qwe123asd", "asd123qwe", "poiuyt123",

  // Dates and years, which people believe are personal and a list already has.
  "01011990", "01012000", "12345678a", "19901990", "20002000",
  "20202020", "20212021", "20222022", "20232023", "20242024",
  "01021994", "11111990", "birthday1", "birthday123", "happybirthday",
  "newyear2024", "christmas1", "halloween1", "valentine1",

  // Freedom / religion / motto shapes.
  "jesus123", "jesuschrist", "godislove", "godisgood", "blessed1",
  "amen1234", "allah1234", "prayer123", "faith123", "hopefaith1",
  "freedom1", "freedom123", "liberty1", "america1", "patriot1",
  "nevergiveup", "believe123", "dreambig1", "youcandoit", "staystrong1",
  "workhard1", "hustle123", "money1234", "moneymoney", "getmoney1",
  "richlife1", "success123", "winner123", "champion1", "legend123",
  "boss12345", "kingkong1", "queenbee1", "thegoat123", "number1fan",
]);
