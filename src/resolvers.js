const { GraphQLScalarType } = require('graphql')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const moment = require('moment')
const mongoose = require('mongoose')
const ObjectId = mongoose.Types.ObjectId
const { User, Folder, Project, Team, Group, Record, Task, Comment } = require('./models/models')
const { getUserId } = require('./utils')

const JWT_SECRET = process.env.JWT_SECRET

async function folderCommon(context, parent, name, shareWith) {
  const userId = getUserId(context)
  return {
    name,
    parent: parent || undefined,
    shareWith: shareWith.concat(parent ? [] : [{
      kind: 'Team',
      item: (await User.findById(userId)).team
    }])
  }
}

function populateTask(promise) {
  return promise
    .populate('folders', 'name')
    .populate('parent', 'name')
    .populate('assignees', 'name email')
    .populate('creator', 'name email')
    .populate('shareWith')
}

function randomChoice(arr) {
  return arr[Math.floor(arr.length * Math.random())]
}

const avatarColors = [
  "D81B60","F06292","F48FB1","FFB74D","FF9800","F57C00","00897B","4DB6AC","80CBC4",
  "80DEEA","4DD0E1","00ACC1","9FA8DA","7986CB","3949AB","8E24AA","BA68C8","CE93D8"
]

const resolvers = {
  Query: {
    async getTeam (_, args, context) {
      const userId = getUserId(context)
      const user = await User.findById(userId)
      return await Team.findById(user.team)
    },
    async getGroup (_, {id}) {
      const group = await Group.findById(group.ib).populate('users')
      return group
    },
    async getFolders (_, {parent}, context) {
      const userId = getUserId(context)
      let folders
      if (parent) {
        folders = await Folder.find({parent})
      } else {
        const user = await User.findById(userId)
        const groups = await Group.find({users: ObjectId(userId)}, '_id')
        const ids = groups.map(o => o._id).concat([ObjectId(userId), user.team])
        folders = await Folder.find({ 'shareWith.item': ids })
      }
      return folders
    },
    async getFolder (_, args, context) {
      const userId = getUserId(context)
      return await Folder.findById(args.id).populate('shareWith')
    },
    async getTasks (_, {parent, folder}, context) {
      if (parent) {
        return await populateTask(Task.find({ parent })).sort({ createdAt: 1 })
      } else {
        return await populateTask(Task.find({ folders: folder })).sort({ createdAt: -1 })
      }
    },
    async getTask (_, {id}, context) {
      const userId = getUserId(context)
      const task = await populateTask(Task.findById(id))
      if (!task) {
        throw new Error('Task with that id does not exist')
      }
      return task
    },
    async getUser (_, {id}, context) {
      const userId = getUserId(context)
      return await User.findById(id || userId)
    },
    async getComments (_, {parent}, context) {
      return await Comment.find({'parent.item': ObjectId(parent)})
                          .populate('user', 'name initials avatarColor')
    }
  },
  Mutation: {
    async createComment(_, {body, parent}, context) {
      const userId = getUserId(context)
      const comment = await Comment.create({
        body,
        user: userId,
        parent,
      })
      return await Comment.findById(comment.id).populate('user', 'name initials avatarColor')
    },
    async createTask(_, {folder, parent, name}, context) {
      const userId = getUserId(context)
      const task = await Task.create({
        name,
        parent,
        folders: folder ? [folder] : [],
        creator: userId
      })
      return await populateTask(Task.findById(task.id))
    },
    async updateTask(_, {id, name}, context) {
      const userId = getUserId(context)
      const task = await populateTask(Task.findById(id))
      task.set({name})
      await task.save()
      return task
    },
    async deleteTask(_, {id}, context) {
      const userId = getUserId(context)
      await Task.deleteOne({_id: id})
      return true
    },
    async createFolder(_, {parent, name, shareWith}, context) {
      const folder = await Folder.create(await folderCommon(context, parent, name, shareWith))
      return await Folder.findById(folder.id).populate('shareWith.item')
    },
    async createProject(_, {parent, name, shareWith, owners, startDate, finishDate}, context) {
      const common = await folderCommon(context, parent, name, shareWith)
      const folder = await Project.create(Object.assign(common, {
        owners,
        startDate,
        finishDate,
        status: 'Green'
      }))
      return await Project.findById(folder.id).populate('shareWith.item')
    },
    async deleteFolder(_, {id}, context) {
      const userId = getUserId(context)
      await Folder.deleteOne({_id: id})
      return true
    },
    async captureEmail (_, {email}) {
      const isEmailTaken = await User.findOne({email})
      if (isEmailTaken) {
        throw new Error('This email is already taken')
      }
      const user = await User.create({
        email,
        role: 'Owner',
        status: 'pending'
      })
      return user
    },
    async invite (_, {emails, groups, role}, context) {
      const user = getUserId(context)
      const team = (await User.findById(user)).team
      const teamMembers = (await User.find({team}, 'email')).map(o => o.email)
      const users = []
      const existingUsers = []
      for (const email of emails) {
        if (teamMembers.includes(email)) {
          existingUsers.push(email)
        } else {
          const user = await User.create({
            email,
            team,
            role,
            status: 'pending'
          })
          users.push(user.id)
        }
      }
      for (const id of groups) {
        const group = await Group.findById(id)
        group.users = users
        await group.save()
      }
      return existingUsers
    },
    async signup (_, {id, firstname, lastname, password}) {
      const user = await User.findById(id)
      if (user.password) {
        // throw new Error('You have already signed up')
      }
      const common = {
        firstname,
        lastname,
        name: `${firstname} ${lastname}`,
        avatarColor: randomChoice(avatarColors),
        password: await bcrypt.hash(password, 10),
        status: 'Active'
      }
      if (false) {
      // if (user.role === 'Owner') {
        const team = await Team.create({
          name: `${common.name}'s Team`
        })
        user.set(Object.assign(common, {team: team.id}))
      } else {
        user.set(common)
      }
      await user.save()
      const token = jwt.sign({id: user.id, email: user.email}, JWT_SECRET, { expiresIn: '1y' })
      return {token, user}
    },
    async login (_, {email, password}) {
      const user = await User.findOne({email})
      if (!user) {
        throw new Error('No user with that email')
      }
      const valid = await bcrypt.compare(password, user.password)
      if (!valid) {
        throw new Error('Incorrect password')
      }
      const token = jwt.sign({id: user.id, email}, JWT_SECRET, { expiresIn: '30d' })
      return {token, user}
    },
    async createGroup (_, {name, initials, avatarColor, users}, context) {
      const user = getUserId(context)
      const group = await Group.create({
        name, initials, avatarColor, users: users.map(o => ObjectId(o))
      })
      return group.id
    }
  },
  Date: new GraphQLScalarType({
    name: 'Date',
    description: 'Date custom scalar type',
    parseValue: (value) => moment(value).toDate(), // value from the client
    serialize: (value) => value.getTime(), // value sent to the client
    parseLiteral: (ast) => ast
  })
}

module.exports = resolvers
