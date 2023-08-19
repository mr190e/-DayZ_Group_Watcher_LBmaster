const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const chokidar = require('chokidar');
const config = require('./config.json');

let groupStore = new Map(); // stores group member data
let userStore = new Map(); // stores user's current group data
let tempStore = new Map(); // stores users who have recently left a group

const saveData = () => {
    fs.writeFileSync('./groupStore.json', JSON.stringify(Array.from(groupStore.entries()), null, 2));
    fs.writeFileSync('./userStore.json', JSON.stringify(Array.from(userStore.entries()), null, 2));
};

const loadData = () => {
    try {
        const groupStoreData = fs.readFileSync('./groupStore.json', 'utf8');
        const groupStoreArray = JSON.parse(groupStoreData);
        groupStore = new Map();
        for (let [groupTag, membersArray] of groupStoreArray) {
            if (!Array.isArray(membersArray)) {
                throw new Error(`groupStore.json has incorrect format: ${groupTag} members is not an array`);
            }
            groupStore.set(groupTag, new Map(membersArray));
        }
        const userStoreData = fs.readFileSync('./userStore.json', 'utf8');
        userStore = new Map(JSON.parse(userStoreData));
    } catch (e) {
        console.error('Failed to load previous data:', e);
    }
};

loadData(); // load data from files at startup

const sendToDiscord = (content) => {
    fetch(config.discordWebhook, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(content),
    }).catch(console.error);
};

const formatGroupInfo = (groupTag, members) => {
    const membersWithOnlineStatus = Array.from(members.values()).map(member => {
        return `${member.name}${member.online ? "🟢" : "🔴"}`;
    });

    return {
        name: groupTag,
        value: membersWithOnlineStatus.join(', '),
        inline: false,
    };
};

const processGroupFile = (filePath) => {
    if (!filePath.endsWith('.json')) {
        console.log(`File ${filePath} is not a JSON file, ignoring...`);
        return;
    }

    let groupTag = path.basename(filePath, '.json');
    console.log(`Processing group file for group ${groupTag}`);
    
    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
            console.error(`Failed to read file: ${filePath}`);
            return;
        }
        let groupData;
        try {
            groupData = JSON.parse(data);
        } catch (e) {
            console.error(`Failed to parse JSON from file: ${filePath}`);
            return;
        }

        let newMembers = new Map(groupData.members.map(m => [m.steamid, {name: m.name, online: m.online === 1 ? true : false}]));
        if (groupStore.has(groupTag)) {
            let oldMembers = groupStore.get(groupTag);
            for (let [steamid, member] of oldMembers) {
                if (!newMembers.has(steamid)) {
                    console.log(`Member **${member.name}** (${steamid}) left group **${groupTag}**`);
                    sendToDiscord({
                        content: `Member **${member.name}** (${steamid}) left group **${groupTag}**`,
                    });
                    tempStore.set(steamid, { name: member.name, oldGroup: groupTag, oldMembers, time: Date.now() });
                    setTimeout(() => {
                        if (tempStore.has(steamid)) {
                            tempStore.delete(steamid);
                            userStore.delete(steamid);
                            saveData();
                        }
                    }, config.groupChangeTime * 60 * 1000); // wait time specified in minutes in config
                }
            }
            for (let [steamid, member] of newMembers) {
				if (!oldMembers.has(steamid)) {
					console.log(`Member **${member.name}** (${steamid}) joined group **${groupTag}**`);
					if (tempStore.has(steamid)) {
						let tempData = tempStore.get(steamid);
						// Check if the new group is the same as the old group
						if (tempData.oldGroup !== groupTag) {
							sendToDiscord({
								content: `<@&${config.roleToPing}>`,
								embeds: [{
									title: `Group Change Detected for ${member.name} (${steamid})`,
									fields: [
										{
											name: `Old Group: ${tempData.oldGroup}`,
											value: formatGroupInfo(tempData.oldGroup, tempData.oldMembers).value,
											inline: false
										},
										{
											name: `New Group: ${groupTag}`,
											value: formatGroupInfo(groupTag, newMembers).value,
											inline: false
										},
									],
								}],
							});
						}
						tempStore.delete(steamid);
					} else {
						sendToDiscord({
							content: `Member **${member.name}** (${steamid}) joined group **${groupTag}**`,
						});
					}
					userStore.set(steamid, groupTag);
				}
            }
        } else {
			let membersList = Array.from(newMembers.values()).map(member => member.name).join(', ');
			console.log(`New group **${groupTag}** (${groupData.name}) has been created with members: ${membersList}`);
			sendToDiscord({
				content: `New group **${groupTag}** (${groupData.name}) has been created with members: **${membersList}**`,
			});
            newMembers.forEach((member, steamid) => userStore.set(steamid, groupTag));
        }
        groupStore.set(groupTag, newMembers);
        saveData();
    });
};

fs.readdirSync(config.directoryPath).forEach(file => {
    if (file.endsWith('.json')) {
        processGroupFile(path.join(config.directoryPath, file));
    }
});

let watcher = chokidar.watch(config.directoryPath, {
    ignored: /(^|[\/\\])\../, 
    persistent: true
});

watcher.on('change', (filePath) => {
    console.log('change event:', typeof filePath, filePath);
    console.log(`Change in JSON detected for ${filePath}`);
    processGroupFile(filePath);
});

watcher.on('add', (filePath) => {
    console.log('add event:', typeof filePath, filePath);
    if (filePath.endsWith('.json')) {
        console.log(`New group JSON file detected: ${filePath}`);
        processGroupFile(filePath);
    }
});

watcher.on('unlink', (filePath) => {
    console.log('unlink event:', typeof filePath, filePath);
    console.log(`Group JSON file deleted: ${filePath}`);
    let groupTag = path.basename(filePath, '.json');
    if (groupStore.has(groupTag)) {
        groupStore.get(groupTag).forEach((member, steamid) => {
            if (userStore.get(steamid) === groupTag) {
                userStore.delete(steamid);
            }
        });
        groupStore.delete(groupTag);
        saveData();
        console.log(`Group **${groupTag}** has been deleted.`);
        sendToDiscord({
            content: `Group **${groupTag}** has been deleted.`,
        });
    }
});
